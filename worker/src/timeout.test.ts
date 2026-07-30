import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { BuildStalledError, BuildTimeoutError, withTimeout } from "./timeout"

describe("withTimeout", () => {
  it("resolves with the work result when it finishes before the timeout", async () => {
    const onTimeout = vi.fn()
    const result = await withTimeout(Promise.resolve("done"), 1000, onTimeout)
    expect(result).toBe("done")
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("surfaces a work rejection that happens before the timeout without invoking onTimeout", async () => {
    const onTimeout = vi.fn()
    const boom = new Error("boom")
    await expect(withTimeout(Promise.reject(boom), 1000, onTimeout)).rejects.toBe(boom)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("throws BuildTimeoutError and invokes onTimeout when work exceeds the timeout", async () => {
    const onTimeout = vi.fn()
    // Work that only settles once the abort runs (mirrors force-closing the browser session so a
    // stuck WebDriver command rejects and the render unwinds).
    let abort: (() => void) | undefined
    const abortableWork = new Promise<void>((_resolve, reject) => {
      abort = () => reject(new Error("aborted"))
    })
    const work = abortableWork.catch(() => undefined)
    onTimeout.mockImplementation(() => abort?.())

    await expect(withTimeout(work, 10, onTimeout)).rejects.toBeInstanceOf(BuildTimeoutError)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it("does not let an onTimeout rejection mask the BuildTimeoutError", async () => {
    const onTimeout = vi.fn().mockRejectedValue(new Error("abort failed"))
    // Work that settles on its own shortly after the timeout so the grace period is satisfied.
    const work = new Promise<void>((resolve) => setTimeout(resolve, 5))

    const error = await withTimeout(work, 1, onTimeout, { abortGraceMs: 1000 }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(BuildTimeoutError)
  })

  it("waits for the aborted work to settle before throwing BuildTimeoutError", async () => {
    // The work does not settle until the abort runs and a tick passes. withTimeout must not throw
    // until that settlement has happened (so the render's mutex-releasing `finally` has run).
    let settled = false
    let release: (() => void) | undefined
    const work = new Promise<void>((resolve) => {
      release = () => {
        settled = true
        resolve()
      }
    })

    const onTimeout = vi.fn().mockImplementation(() => {
      // Settle on the next tick, simulating the async unwind after force-teardown.
      setTimeout(() => release?.(), 5)
    })

    const onUnrecoverable = vi.fn()
    const error = await withTimeout(work, 1, onTimeout, {
      abortGraceMs: 1000,
      onUnrecoverable,
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BuildTimeoutError)
    // If withTimeout had thrown before awaiting settlement, this would be false.
    expect(settled).toBe(true)
    expect(onUnrecoverable).not.toHaveBeenCalled()
  })

  it("invokes onUnrecoverable when the aborted work never settles within the grace period", async () => {
    // The abort fails to unstick the work; it never settles. withTimeout must call
    // onUnrecoverable (in production this exits the process so a clean worker is restarted).
    const work = new Promise<void>(() => {
      /* never settles */
    })
    const onTimeout = vi.fn()
    const onUnrecoverable = vi.fn()

    // Race the withTimeout call against a guard. Because onUnrecoverable here does NOT terminate,
    // withTimeout will keep awaiting the never-settling work, so it should never resolve/reject.
    const guard = withTimeout(work, 1, onTimeout, {
      abortGraceMs: 20,
      onUnrecoverable,
    })
    const settledMarker = Symbol("settled")
    const raced = await Promise.race([
      guard.then(
        () => settledMarker,
        () => settledMarker,
      ),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol("pending")), 100)),
    ])

    // onUnrecoverable must have fired once the grace period elapsed.
    expect(onUnrecoverable).toHaveBeenCalledTimes(1)
    // And withTimeout must NOT have settled, because the work still holds shared state — freeing
    // the worker here would let it accept a build against a poisoned mutex.
    expect(raced).not.toBe(settledMarker)
  })
})

describe("withTimeout progress watchdog (#452)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** An abortable never-settling work promise, mirroring a stuck WebDriver render. */
  function abortableWork(): { work: Promise<void>; abort: () => void } {
    let abort: (() => void) | undefined
    const inner = new Promise<void>((_resolve, reject) => {
      abort = () => reject(new Error("aborted"))
    })
    return { work: inner.catch(() => undefined), abort: () => abort?.() }
  }

  it("rejects with BuildStalledError (a BuildTimeoutError) after stallTimeoutMs of no progress, via the abort path", async () => {
    const progress = { lastMs: Date.now() }
    const { work, abort } = abortableWork()
    const onTimeout = vi.fn().mockImplementation(() => abort())
    const onUnrecoverable = vi.fn()

    const resultPromise = withTimeout(work, 60 * 60_000, onTimeout, {
      abortGraceMs: 1000,
      onUnrecoverable,
      stall: {
        getLastProgressMs: () => progress.lastMs,
        stallTimeoutMs: 5 * 60_000,
        pollIntervalMs: 15_000,
      },
    }).catch((e: unknown) => e)

    // One poll past the stall window with no progress: the watchdog fires.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000)
    const error = await resultPromise
    expect(error).toBeInstanceOf(BuildStalledError)
    // Subclass relationship: worker.ts's terminal BuildTimeoutError handling applies unchanged.
    expect(error).toBeInstanceOf(BuildTimeoutError)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    // The abort unstuck the work, so the grace period was satisfied.
    expect(onUnrecoverable).not.toHaveBeenCalled()
  })

  it("never fires while progress continues, even far past the old flat cap", async () => {
    const progress = { lastMs: Date.now() }
    let resolveWork: (() => void) | undefined
    const work = new Promise<string>((resolve) => {
      resolveWork = () => resolve("done")
    })
    const onTimeout = vi.fn()

    const resultPromise = withTimeout(work, 24 * 60 * 60_000, onTimeout, {
      stall: {
        getLastProgressMs: () => progress.lastMs,
        stallTimeoutMs: 5 * 60_000,
        pollIntervalMs: 15_000,
      },
    })

    // 60 minutes of steady progress — four times the old 15-minute flat cap.
    for (let i = 0; i < 240; i++) {
      await vi.advanceTimersByTimeAsync(15_000)
      progress.lastMs = Date.now()
    }
    resolveWork?.()
    await expect(resultPromise).resolves.toBe("done")
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("the explicit ceiling still fires as BuildTimeoutError even when progress is steady", async () => {
    const progress = { lastMs: Date.now() }
    const { work, abort } = abortableWork()
    const onTimeout = vi.fn().mockImplementation(() => abort())

    const resultPromise = withTimeout(work, 100, onTimeout, {
      abortGraceMs: 1000,
      onUnrecoverable: vi.fn(),
      stall: {
        getLastProgressMs: () => progress.lastMs,
        stallTimeoutMs: 60_000,
        pollIntervalMs: 10,
      },
    }).catch((e: unknown) => e)

    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(10)
      progress.lastMs = Date.now()
    }
    const error = await resultPromise
    expect(error).toBeInstanceOf(BuildTimeoutError)
    expect(error).not.toBeInstanceOf(BuildStalledError)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it("invokes onUnrecoverable with the stall error when the aborted work never settles", async () => {
    const progress = { lastMs: Date.now() }
    const work = new Promise<void>(() => {
      /* never settles, even after abort */
    })
    const onTimeout = vi.fn()
    const onUnrecoverable = vi.fn()

    const guard = withTimeout(work, 60 * 60_000, onTimeout, {
      abortGraceMs: 1000,
      onUnrecoverable,
      stall: {
        getLastProgressMs: () => progress.lastMs,
        stallTimeoutMs: 60_000,
        pollIntervalMs: 5_000,
      },
    })
    // Swallow the (never-delivered) rejection; the promise dangles by design once the work is
    // wedged beyond recovery.
    guard.catch(() => undefined)

    // Stall window elapses with no progress, then the grace period elapses without settlement.
    await vi.advanceTimersByTimeAsync(60_000 + 5_000 + 1000 + 1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onUnrecoverable).toHaveBeenCalledTimes(1)
    expect(onUnrecoverable.mock.calls[0]![0]).toBeInstanceOf(BuildStalledError)
  })
})
