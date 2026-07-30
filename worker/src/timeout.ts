/**
 * Error thrown when a build exceeds its configured maximum duration. Distinct from generic
 * failures so the task scheduler can treat it as non-retryable (a build that ran too long is
 * almost always stuck or pathologically large, and retrying would just burn another full
 * timeout window).
 */
export class BuildTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Build exceeded maximum duration of ${timeoutMs}ms`)
    this.name = "BuildTimeoutError"
  }
}

/**
 * Error thrown when the progress watchdog (issue #452) detects that no story has completed for
 * the configured stall window. Extends {@link BuildTimeoutError} so every consumer that treats a
 * build timeout as terminal/non-retryable (worker.ts) handles a stalled build identically — a
 * build that stopped making progress is wedged, and retrying it would just wedge the next
 * worker.
 */
export class BuildStalledError extends BuildTimeoutError {
  constructor(stallMs: number) {
    super(stallMs)
    this.message = `Build made no progress for ${stallMs}ms; aborting as stalled`
    this.name = "BuildStalledError"
  }
}

/**
 * How long, after the abort (`onTimeout`) has run, to wait for the original `work` promise to
 * actually settle before declaring the abort failed. Force-closing the browser sessions should
 * cause the in-flight WebDriver commands to reject almost immediately and unwind the stack
 * (running the render's `finally` blocks, which return each session to the browser pool). If it
 * doesn't settle within this grace period the work is genuinely wedged and we treat it as
 * unrecoverable in-process.
 */
const DEFAULT_ABORT_GRACE_MS = 10 * 1000

/**
 * How often the progress watchdog re-checks for a stall. Coarse relative to the minutes-scale
 * stall window: the check is a cheap in-process comparison, and a stall being detected up to one
 * poll interval late is immaterial.
 */
const DEFAULT_STALL_POLL_INTERVAL_MS = 15 * 1000

/** Progress-watchdog configuration for {@link withTimeout} (issue #452). */
export interface StallOptions {
  /**
   * Returns the ms timestamp (Date.now() domain) of the most recent forward progress. Values
   * before withTimeout started are treated as "no progress yet" — the stall clock never starts
   * earlier than the watchdog itself.
   */
  getLastProgressMs: () => number
  /** Abort the work when no progress has been observed for this long (ms). */
  stallTimeoutMs: number
  /** Poll interval (ms). Defaults to {@link DEFAULT_STALL_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number
}

export interface WithTimeoutOptions {
  /**
   * Grace period (ms) to wait for `work` to settle after `onTimeout` runs. Defaults to
   * {@link DEFAULT_ABORT_GRACE_MS}.
   */
  abortGraceMs?: number
  /**
   * Invoked when the abort fails to make `work` settle within the grace period — i.e. the render
   * is wedged in a way that force-teardown could not unstick (a hung WebDriver op that never
   * rejects, leaving its browser-pool session checked out). Letting the worker continue would
   * let it accept a new build while the wedged render still holds process resources (Chrome
   * sessions, memory), poisoning the worker until restart. The default therefore exits the
   * process non-zero so the orchestrator restarts a clean worker. Overridable for testing.
   */
  onUnrecoverable?: (error: Error) => void
  /**
   * Progress watchdog (issue #452): when set, the work is also aborted — with
   * {@link BuildStalledError}, via the same abort/grace/onUnrecoverable path as the flat cap —
   * once `now - max(start, getLastProgressMs()) > stallTimeoutMs`. When absent, behavior is
   * identical to the plain flat-cap race.
   */
  stall?: StallOptions
}

function defaultOnUnrecoverable(error: Error): void {
  process.stderr.write(
    `withTimeout: aborted work did not settle within the grace period; exiting worker so the ` +
      `orchestrator restarts a clean process. ${error.message}\n`,
  )
  process.exit(1)
}

/**
 * Race `work` against a timeout. If the timeout fires first, `onTimeout` is invoked to abort the
 * in-flight work (e.g. by force-closing the browser session so pending commands reject), and then
 * — crucially — we wait for the original `work` promise to actually settle before throwing
 * {@link BuildTimeoutError}.
 *
 * Why wait? The underlying `work` promise is not cancellable on its own; `onTimeout` is only the
 * mechanism that interrupts it. If we rejected immediately (as a naive timeout race would), the
 * caller would be free to start the next build while the previous render is still unwinding — and
 * in the scenario this guards against (a `processStory`/WebDriver op stuck mid-render), the
 * render's `finally` blocks would not yet have run, so its browser-pool sessions and other
 * resources would still be in use while a new build spins up more. Awaiting the render's
 * settlement guarantees its cleanup (returning sessions to the pool, tearing the pool down) has
 * run before we hand control back.
 *
 * If the work does not settle within `abortGraceMs` after the abort, the render is wedged beyond
 * in-process recovery; `onUnrecoverable` is invoked (by default, exit the process non-zero) so a
 * fresh worker is started rather than accepting work against poisoned shared state.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
  options: WithTimeoutOptions = {},
): Promise<T> {
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS
  const onUnrecoverable = options.onUnrecoverable ?? defaultOnUnrecoverable

  // Never let the original work promise reject unhandled while we wait on the timeout branch.
  // We attach a catch that swallows the rejection for the race, but retain `work` itself so we
  // can await its settlement below.
  const workSettled = work.then(
    () => undefined,
    () => undefined,
  )

  let timer: NodeJS.Timeout | undefined
  let stallTimer: NodeJS.Timeout | undefined
  const capError = new BuildTimeoutError(timeoutMs)
  // Which watchdog error (flat cap or stall) actually fired, if any. Whichever fires first wins;
  // both are surfaced through the identical abort/grace/onUnrecoverable path below.
  let firedError: BuildTimeoutError | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      firedError ??= capError
      reject(firedError)
    }, timeoutMs)
    timer.unref()

    // Progress watchdog (issue #452): an unref'd poll that rejects the race with
    // BuildStalledError once no progress has been observed for stallTimeoutMs. The stall clock
    // starts at `startMs`, so a build that never completes a single story stalls out
    // stallTimeoutMs after the watchdog begins.
    const stall = options.stall
    if (stall) {
      const startMs = Date.now()
      stallTimer = setInterval(() => {
        const lastProgressMs = Math.max(startMs, stall.getLastProgressMs())
        if (Date.now() - lastProgressMs > stall.stallTimeoutMs) {
          firedError ??= new BuildStalledError(stall.stallTimeoutMs)
          reject(firedError)
        }
      }, stall.pollIntervalMs ?? DEFAULT_STALL_POLL_INTERVAL_MS)
      stallTimer.unref()
    }
  })

  try {
    return await Promise.race([work, timeout])
  } catch (error) {
    if (firedError == undefined || error !== firedError) {
      // `work` rejected on its own before either watchdog fired; surface that error directly.
      throw error
    }

    // A watchdog won (flat cap or stall). Fire the abort, then wait for the original work to
    // settle so its cleanup (returning sessions to the browser pool) runs before we hand control
    // back to the caller.
    try {
      await onTimeout()
    } catch {
      // Swallow abort errors; the BuildTimeoutError below is the meaningful signal.
    }

    const settledInTime = await Promise.race([
      workSettled.then(() => true),
      new Promise<false>((resolve) => {
        const graceTimer = setTimeout(() => resolve(false), abortGraceMs)
        graceTimer.unref()
      }),
    ])

    if (!settledInTime) {
      // The abort did not unstick the render within the grace period. Treat as unrecoverable.
      onUnrecoverable(firedError)
      // If onUnrecoverable did not terminate the process (e.g. in tests), still wait for the
      // work to settle so we never resolve while it may hold shared state, then surface the
      // timeout. This await may hang if the work truly never settles, which is the correct
      // behavior: we must not free the worker while the render still holds its resources.
      await workSettled
    }

    throw firedError
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    if (stallTimer) {
      clearInterval(stallTimer)
    }
  }
}
