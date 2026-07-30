import { expect, describe, it, vi } from "vitest"

import type { BrowserPool } from "./browserPool"
import { runStoryPipeline, settlePrewarmedPool, type CaptureOutcome } from "./pipeline"

/**
 * Tests for the capture/finalize story pipeline and the pool-prewarm join (issue #456, Phase A).
 *
 * The pipeline is exercised with plain fakes: `capture` stands in for
 * captureStoryWithRetry (which acquires/releases a pooled browser session internally) and
 * `finalize` for finalizeStoryWithRecording (S3/diff/DB; no browser). Deferred promises let the
 * tests hold finalizes open while asserting what the capture lane is doing.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let queued microtasks (and zero-delay continuations) run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

function capturedOutcome(story: string): CaptureOutcome<string, string> {
  return { kind: "captured", captured: `captured:${story}` }
}

describe("runStoryPipeline (#456)", () => {
  it("resolves with one finalize result per story, in input order", async () => {
    const results = await runStoryPipeline<string, string, string>({
      stories: ["a", "b", "c"],
      captureConcurrency: 2,
      finalizeConcurrency: 2,
      queueLimit: 16,
      capture: async (story) => capturedOutcome(story),
      finalize: async (story, captured) => `result:${story}:${captured}`,
    })

    expect(results).toEqual(["result:a:captured:a", "result:b:captured:b", "result:c:captured:c"])
  })

  it("frees the capture slot (and its session) before finalize completes", async () => {
    // An instrumented fake "pool": capture acquires/releases a session around its own work, the
    // way captureStoryWithRetry does around the browser-facing phase. Finalizes never resolve
    // until released manually, so any capture that proceeds while they are pending proves the
    // sessions were released without waiting on S3/DB work.
    let sessionsInUse = 0
    let maxSessionsInUse = 0
    const captureStarted: string[] = []
    const finalizeGates = new Map<string, Deferred<string>>()

    const pipeline = runStoryPipeline<string, string, string>({
      stories: ["a", "b", "c"],
      captureConcurrency: 1, // one browser session
      finalizeConcurrency: 4,
      queueLimit: 16,
      capture: async (story) => {
        sessionsInUse++
        maxSessionsInUse = Math.max(maxSessionsInUse, sessionsInUse)
        captureStarted.push(story)
        await Promise.resolve() // simulate browser work
        sessionsInUse-- // session released at the end of capture, before finalize
        return capturedOutcome(story)
      },
      finalize: (story) => {
        const gate = deferred<string>()
        finalizeGates.set(story, gate)
        return gate.promise
      },
    })

    await flushMicrotasks()

    // Story b and c captured while a (and b) were still finalizing: the single session never
    // waited on a finalize, and concurrent session usage never exceeded the pool size.
    expect(captureStarted).toEqual(["a", "b", "c"])
    expect(maxSessionsInUse).toBe(1)
    expect(finalizeGates.size).toBe(3)

    // The pipeline must NOT settle until every finalize does (build completion gates on it).
    let settled = false
    void pipeline.then(() => (settled = true))
    await flushMicrotasks()
    expect(settled).toBe(false)

    for (const [story, gate] of finalizeGates) {
      gate.resolve(`result:${story}`)
    }
    await expect(pipeline).resolves.toEqual(["result:a", "result:b", "result:c"])
  })

  it("blocks capture #(queueLimit+1) until a finalize drains", async () => {
    const captureStarted: string[] = []
    const finalizeGates = new Map<string, Deferred<string>>()

    const pipeline = runStoryPipeline<string, string, string>({
      stories: ["a", "b", "c", "d"],
      captureConcurrency: 1,
      finalizeConcurrency: 4,
      queueLimit: 2,
      capture: async (story) => {
        captureStarted.push(story)
        return capturedOutcome(story)
      },
      finalize: (story) => {
        const gate = deferred<string>()
        finalizeGates.set(story, gate)
        return gate.promise
      },
    })

    await flushMicrotasks()

    // Two stories are captured-but-unfinalized (the queue limit); capture of story c must wait.
    expect(captureStarted).toEqual(["a", "b"])

    // Draining one finalize frees a queue slot; exactly one more capture proceeds.
    finalizeGates.get("a")!.resolve("result:a")
    await flushMicrotasks()
    expect(captureStarted).toEqual(["a", "b", "c"])

    finalizeGates.get("b")!.resolve("result:b")
    await flushMicrotasks()
    expect(captureStarted).toEqual(["a", "b", "c", "d"])

    finalizeGates.get("c")!.resolve("result:c")
    finalizeGates.get("d")!.resolve("result:d")
    await expect(pipeline).resolves.toEqual(["result:a", "result:b", "result:c", "result:d"])
  })

  it("passes recorded capture outcomes through without finalizing them", async () => {
    const finalize = vi.fn(async (story: string) => `finalized:${story}`)
    const onStoryComplete = vi.fn()
    const onCaptureComplete = vi.fn()

    const results = await runStoryPipeline<string, string, string>({
      stories: ["ok", "broken", "ok2"],
      captureConcurrency: 2,
      finalizeConcurrency: 2,
      queueLimit: 2, // also proves a recorded outcome releases its backpressure slot
      capture: async (story) =>
        story === "broken"
          ? { kind: "recorded", result: `failed-row:${story}` }
          : capturedOutcome(story),
      finalize,
      hooks: { onStoryComplete, onCaptureComplete },
    })

    expect(results).toEqual(["finalized:ok", "failed-row:broken", "finalized:ok2"])
    expect(finalize).toHaveBeenCalledTimes(2)
    // Every story completes exactly once; only actual captures fire onCaptureComplete.
    expect(onStoryComplete).toHaveBeenCalledTimes(3)
    expect(onCaptureComplete).toHaveBeenCalledTimes(2)
  })

  it("rejects when a capture rejects, after in-flight finalizes settle", async () => {
    const finalizeGate = deferred<string>()
    let finalizeSettled = false

    const pipeline = runStoryPipeline<string, string, string>({
      stories: ["a", "boom"],
      captureConcurrency: 2,
      finalizeConcurrency: 2,
      queueLimit: 16,
      capture: async (story) => {
        if (story === "boom") {
          throw new Error("capture blew up")
        }
        return capturedOutcome(story)
      },
      finalize: async () => {
        const result = await finalizeGate.promise
        finalizeSettled = true
        return result
      },
    })

    // Give the pipeline time to observe the capture failure, then release the finalize.
    await flushMicrotasks()
    finalizeGate.resolve("result:a")

    await expect(pipeline).rejects.toThrow("capture blew up")
    // The already-enqueued finalize was awaited before the rejection surfaced.
    expect(finalizeSettled).toBe(true)
  })

  it("fires onCapturesDrained once every capture has settled", async () => {
    const order: string[] = []
    const finalizeGate = deferred<string>()

    const pipeline = runStoryPipeline<string, string, string>({
      stories: ["a"],
      captureConcurrency: 1,
      finalizeConcurrency: 1,
      queueLimit: 1,
      capture: async (story) => capturedOutcome(story),
      finalize: async () => {
        order.push("finalize-start")
        return await finalizeGate.promise
      },
      hooks: {
        onCapturesDrained: () => order.push("captures-drained"),
      },
    })

    await flushMicrotasks()
    expect(order).toContain("captures-drained")
    finalizeGate.resolve("result:a")
    await pipeline
  })
})

describe("settlePrewarmedPool (#456)", () => {
  function fakePool() {
    const destroyAll = vi.fn(async () => undefined)
    const pool = {
      size: 1,
      sessions: [],
      acquire: vi.fn(),
      release: vi.fn(),
      replace: vi.fn(),
      setSessionInit: vi.fn(),
      destroyAll,
    } as unknown as BrowserPool
    return { pool, destroyAll }
  }

  it("resolves with the pool and work result when both succeed", async () => {
    const { pool, destroyAll } = fakePool()
    const { pool: settled, workResult } = await settlePrewarmedPool(
      Promise.resolve(pool),
      Promise.resolve("extracted"),
    )
    expect(settled).toBe(pool)
    expect(workResult).toBe("extracted")
    expect(destroyAll).not.toHaveBeenCalled()
  })

  it("destroys the (possibly still-launching) pool when the download/extract work fails", async () => {
    const { pool, destroyAll } = fakePool()
    const poolGate = deferred<BrowserPool>()
    const workError = new Error("download failed")

    const settle = settlePrewarmedPool(poolGate.promise, Promise.reject(workError))
    // The pool finishes launching AFTER the work already failed; it must still be torn down.
    poolGate.resolve(pool)

    await expect(settle).rejects.toThrow("download failed")
    expect(destroyAll).toHaveBeenCalledTimes(1)
  })

  it("surfaces the work error (not a crash) when pool creation also fails", async () => {
    const settle = settlePrewarmedPool(
      Promise.reject(new Error("chrome failed to launch")),
      Promise.reject(new Error("download failed")),
    )
    await expect(settle).rejects.toThrow("download failed")
  })

  it("surfaces the pool error once the work has succeeded", async () => {
    const settle = settlePrewarmedPool(
      Promise.reject(new Error("chrome failed to launch")),
      Promise.resolve("extracted"),
    )
    await expect(settle).rejects.toThrow("chrome failed to launch")
  })
})
