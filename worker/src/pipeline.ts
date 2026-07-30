import pLimit from "p-limit"

import type { BrowserPool } from "./browserPool"

/**
 * Per-story capture/finalize pipeline (issue #456, Phase A).
 *
 * Rendering a story used to hold a pooled Chrome session for the whole per-story unit of work:
 * navigate + stabilize + screenshot AND the S3 uploads, baseline diff, and TestResult save that
 * follow. The trailing half needs no browser, so with N sessions the pool sat idle for the
 * S3/DB tail of every story. This module splits the work into two lanes:
 *
 *  - capture (session-holding): bounded by the browser-pool size. On success the session is
 *    released immediately and the story is handed to the finalize lane.
 *  - finalize (no browser): S3 screenshot/diff uploads, baseline comparison, and the DB save,
 *    bounded by its own concurrency limit.
 *
 * A counting semaphore caps the number of stories that are captured but not yet finalized
 * (each buffers one screenshot PNG in memory): when the backlog hits `queueLimit`, the next
 * capture waits for a finalize to drain before starting.
 *
 * The pipeline's promise resolves only after EVERY finalize has settled, so build completion
 * (result aggregation, status flip, VCS post) still sees the full result set.
 */

/**
 * The outcome of a story's capture phase.
 *
 *  - `captured`: the screenshot was taken; the story proceeds to the finalize lane.
 *  - `recorded`: the story already produced its final (failed) result during capture — e.g. the
 *    story threw, or the infra retry budget was exhausted — so there is nothing to finalize.
 */
export type CaptureOutcome<C, R> =
  | { kind: "captured"; captured: C }
  | { kind: "recorded"; result: R }

export interface StoryPipelineHooks {
  /**
   * A story's capture phase completed and its browser session was released (fired before the
   * finalize is enqueued). Cheap; used to feed the progress watchdog during finalize backlogs.
   */
  onCaptureComplete?: () => void
  /**
   * A story fully settled: its finalize completed, or its capture already recorded the final
   * (failed) result. Fired exactly once per story on the success path.
   */
  onStoryComplete?: () => void
  /** Every capture has settled (finalizes may still be draining). */
  onCapturesDrained?: () => void
}

export interface StoryPipelineOptions<S, C, R> {
  stories: readonly S[]
  /** Concurrent captures; should equal the browser-pool size. Values < 1 are clamped to 1. */
  captureConcurrency: number
  /** Concurrent finalizes (S3/diff/DB; no browser held). Values < 1 are clamped to 1. */
  finalizeConcurrency: number
  /**
   * Max stories captured but not yet finalized (bounds buffered screenshot memory). Awaited
   * before the next capture starts. Values < 1 are clamped to 1.
   */
  queueLimit: number
  /**
   * Capture one story. Expected to record per-story failures itself (returning `recorded`) and
   * only reject on build-level failures (e.g. the database is down, or the build watchdog
   * force-closed the sessions) — a rejection aborts the pipeline.
   */
  capture: (story: S) => Promise<CaptureOutcome<C, R>>
  /**
   * Finalize one captured story. Expected to record per-story failures itself and resolve with
   * the story's result; a rejection aborts the pipeline.
   */
  finalize: (story: S, captured: C) => Promise<R>
  hooks?: StoryPipelineHooks
}

/** A minimal counting semaphore (FIFO waiters). */
function createSemaphore(count: number): { acquire(): Promise<void>; release(): void } {
  let free = count
  const waiters: Array<() => void> = []
  return {
    acquire(): Promise<void> {
      if (free > 0) {
        free--
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
    release(): void {
      const waiter = waiters.shift()
      if (waiter != undefined) {
        waiter()
      } else {
        free++
      }
    },
  }
}

/**
 * Runs every story through the capture lane and pipelines its finalize work off the render path.
 * Resolves with one result per story, in input order, once every finalize has settled. Rejects
 * if any capture or finalize rejects (per-story failures are expected to be *recorded*, not
 * thrown — see {@link StoryPipelineOptions}); already-enqueued finalizes are awaited before the
 * rejection propagates so no work is left dangling.
 */
export async function runStoryPipeline<S, C, R>({
  stories,
  captureConcurrency,
  finalizeConcurrency,
  queueLimit,
  capture,
  finalize,
  hooks,
}: StoryPipelineOptions<S, C, R>): Promise<R[]> {
  const captureLimit = pLimit(Math.max(1, captureConcurrency))
  const finalizeLimit = pLimit(Math.max(1, finalizeConcurrency))
  const queueSlots = createSemaphore(Math.max(1, queueLimit))
  const finalizePromises: Array<Promise<void>> = []
  const results: R[] = new Array<R>(stories.length)

  const captures = stories.map((story, index) =>
    captureLimit(async () => {
      // Backpressure: hold the capture slot until the un-finalized backlog has room. The slot is
      // released on finalize completion (or immediately for `recorded` outcomes below).
      await queueSlots.acquire()
      let handedOff = false
      try {
        const outcome = await capture(story)
        if (outcome.kind === "recorded") {
          // The capture phase already produced the story's final (failed) result; nothing to
          // finalize.
          results[index] = outcome.result
          hooks?.onStoryComplete?.()
          return
        }
        hooks?.onCaptureComplete?.()
        // Hand off to the finalize lane. The push happens synchronously before this capture slot
        // is freed, so by the time every capture has settled, every finalize is enqueued.
        handedOff = true
        finalizePromises.push(
          finalizeLimit(async () => {
            try {
              results[index] = await finalize(story, outcome.captured)
            } finally {
              queueSlots.release()
              hooks?.onStoryComplete?.()
            }
          }),
        )
      } finally {
        if (!handedOff) {
          queueSlots.release()
        }
      }
    }),
  )

  try {
    await Promise.all(captures)
  } catch (err) {
    // A capture rejected (build-level failure): let the already-enqueued finalizes settle so
    // their rejections are observed (no unhandled rejections) before the abort propagates.
    await Promise.allSettled(finalizePromises)
    throw err
  }
  hooks?.onCapturesDrained?.()
  await Promise.all(finalizePromises)
  return results
}

/**
 * A1 prewarm (issue #456): browser-pool creation is started *before* the tarball download so the
 * two run concurrently, and this helper joins the eagerly-started pool promise with the
 * download/extract work:
 *
 *  - both succeed → resolves with the pool once the work is done;
 *  - the work fails → the pool (which may still be launching) is awaited and destroyed so an
 *    early build failure never leaks headless-Chrome processes, then the work error is rethrown;
 *  - pool creation fails (its own partial teardown is handled inside `createBrowserPool`) → the
 *    pool error is rethrown once the work has settled.
 *
 * The pool promise is observed eagerly, so a pool-creation failure while the work is still in
 * flight is never an unhandled rejection.
 */
export async function settlePrewarmedPool<T>(
  poolPromise: Promise<BrowserPool>,
  work: Promise<T>,
): Promise<{ pool: BrowserPool; workResult: T }> {
  // Eagerly observe the pool promise; its error (if any) surfaces at the awaits below.
  const observedPool = poolPromise.catch(() => undefined)
  let workResult: T
  try {
    workResult = await work
  } catch (workErr) {
    // The work failed first: tear down whatever the pool launched. A pool-creation failure is
    // ignored here — the work error is the one to surface.
    const pool = await observedPool
    if (pool) {
      await pool.destroyAll()
    }
    throw workErr
  }
  return { pool: await poolPromise, workResult }
}
