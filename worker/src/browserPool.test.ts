import { afterEach, describe, expect, it, vi } from "vitest"
import type { Browser } from "webdriverio"

import { createBrowserPool, type PooledSession } from "./browserPool"

vi.mock("./log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

function fakeBrowser(): Browser {
  return { deleteSession: vi.fn().mockResolvedValue(undefined) } as unknown as Browser
}

afterEach(() => {
  vi.useRealTimers()
})

describe("createBrowserPool", () => {
  it("creates `size` sessions via the factory", async () => {
    const factory = vi.fn(async () => fakeBrowser())
    const pool = await createBrowserPool(3, factory)
    expect(factory).toHaveBeenCalledTimes(3)
    expect(pool.size).toBe(3)
    expect(pool.sessions).toHaveLength(3)
    expect(pool.sessions.map((s) => s.id).sort()).toEqual([0, 1, 2])
  })

  it("clamps size to at least 1", async () => {
    const factory = vi.fn(async () => fakeBrowser())
    const pool = await createBrowserPool(0, factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(pool.size).toBe(1)
  })

  it("hands out distinct sessions until exhausted, then waits for a release", async () => {
    const pool = await createBrowserPool(2, async () => fakeBrowser())
    const a = await pool.acquire()
    const b = await pool.acquire()
    expect(a).not.toBe(b)

    // Pool exhausted: the next acquire pends until something is released.
    let resolved: PooledSession | undefined
    const pending = pool.acquire().then((x) => (resolved = x))
    await Promise.resolve()
    expect(resolved).toBeUndefined()

    await pool.release(a)
    await pending
    expect(resolved).toBe(a) // the released session is handed straight to the waiter
  })

  it("returns a session to the available set when no waiter is queued", async () => {
    const pool = await createBrowserPool(1, async () => fakeBrowser())
    const a = await pool.acquire()
    await pool.release(a)
    const again = await pool.acquire()
    expect(again).toBe(a)
  })

  it("destroyAll closes every session and tolerates an already-closed one", async () => {
    const del0 = vi.fn().mockResolvedValue(undefined)
    const del1 = vi
      .fn()
      .mockRejectedValueOnce(new Error("already gone"))
      .mockResolvedValue(undefined)
    const browsers = [
      { deleteSession: del0 } as unknown as Browser,
      { deleteSession: del1 } as unknown as Browser,
    ]
    let i = 0
    const pool = await createBrowserPool(2, async () => browsers[i++]!)
    await expect(pool.destroyAll()).resolves.toBeUndefined()
    expect(del0).toHaveBeenCalled()
    expect(del1).toHaveBeenCalled()
  })

  it("tears down already-created sessions if a later one fails to init, then rethrows", async () => {
    const goodDel = vi.fn().mockResolvedValue(undefined)
    const good = { deleteSession: goodDel } as unknown as Browser
    let call = 0
    // call 1 resolves immediately (pushed first by microtask ordering); call 2 throws.
    const factory = vi.fn(async (): Promise<Browser> => {
      call += 1
      if (call === 2) {
        throw new Error("init failed")
      }
      return good
    })
    await expect(createBrowserPool(2, factory)).rejects.toThrow("init failed")
    expect(goodDel).toHaveBeenCalled()
  })

  describe("replace", () => {
    it("closes the old browser, reruns the factory and sessionInit, and resets counters", async () => {
      const oldDelete = vi.fn().mockResolvedValue(undefined)
      const oldBrowserInstance = { deleteSession: oldDelete } as unknown as Browser
      const factory = vi
        .fn<() => Promise<Browser>>()
        .mockResolvedValueOnce(oldBrowserInstance)
        .mockImplementation(async () => fakeBrowser())
      const pool = await createBrowserPool(1, factory)
      const session = await pool.acquire()
      const oldBrowser = session.browser
      session.storiesRendered = 42
      session.consecutiveInfraFailures = 1

      const sessionInit = vi.fn().mockResolvedValue(undefined)
      pool.setSessionInit(sessionInit)

      await pool.replace(session, "probe-failed")

      expect(oldDelete).toHaveBeenCalled()
      expect(factory).toHaveBeenCalledTimes(2) // initial creation + replacement
      expect(session.browser).not.toBe(oldBrowser)
      expect(sessionInit).toHaveBeenCalledTimes(1)
      expect(sessionInit).toHaveBeenCalledWith(session.browser)
      expect(session.storiesRendered).toBe(0)
      expect(session.consecutiveInfraFailures).toBe(0)
    })

    it("retries browser creation once, then throws", async () => {
      const good = fakeBrowser()
      const factory = vi
        .fn<() => Promise<Browser>>()
        .mockResolvedValueOnce(fakeBrowser()) // initial pool creation
        .mockRejectedValueOnce(new Error("create failed 1"))
        .mockResolvedValueOnce(good)
        .mockRejectedValueOnce(new Error("create failed 2"))
        .mockRejectedValueOnce(new Error("create failed 3"))
      const pool = await createBrowserPool(1, factory)
      const session = await pool.acquire()

      // First replace: creation fails once, the retry succeeds.
      await pool.replace(session, "probe-failed")
      expect(session.browser).toBe(good)

      // Second replace: creation fails twice -> throws the second error.
      await expect(pool.replace(session, "probe-failed")).rejects.toThrow("create failed 3")
    })

    it("tolerates a hanging deleteSession on the old browser (bounded by a local timer)", async () => {
      vi.useFakeTimers()
      const hangingDelete = vi.fn(() => new Promise<void>(() => undefined)) // never settles
      const dead = { deleteSession: hangingDelete } as unknown as Browser
      const fresh = fakeBrowser()
      const factory = vi
        .fn<() => Promise<Browser>>()
        .mockResolvedValueOnce(dead)
        .mockResolvedValueOnce(fresh)
      const pool = await createBrowserPool(1, factory)
      const session = await pool.acquire()

      let replaced = false
      const replacing = pool.replace(session, "probe-failed").then(() => (replaced = true))

      // The hung delete holds replace() until the 10 s local timer expires...
      await vi.advanceTimersByTimeAsync(9_000)
      expect(replaced).toBe(false)
      // ...after which the replacement proceeds without waiting for the dead session.
      await vi.advanceTimersByTimeAsync(1_500)
      await replacing
      expect(session.browser).toBe(fresh)
    })
  })

  describe("release-time replacement", () => {
    it("recycles a session once it has rendered `recycleAfterStories` stories", async () => {
      const factory = vi.fn(async () => fakeBrowser())
      const pool = await createBrowserPool(1, factory, { recycleAfterStories: 2 })
      const session = await pool.acquire()
      const firstBrowser = session.browser

      session.storiesRendered = 1
      await pool.release(session)
      expect(session.browser).toBe(firstBrowser) // below threshold: kept

      await pool.acquire()
      session.storiesRendered = 2
      await pool.release(session)
      expect(session.browser).not.toBe(firstBrowser) // threshold hit: recycled
      expect(session.storiesRendered).toBe(0)
      expect(factory).toHaveBeenCalledTimes(2)
    })

    it("replaces a session after `maxConsecutiveInfraFailures` consecutive infra failures", async () => {
      const factory = vi.fn(async () => fakeBrowser())
      const pool = await createBrowserPool(1, factory, { maxConsecutiveInfraFailures: 2 })
      const session = await pool.acquire()
      const firstBrowser = session.browser

      session.consecutiveInfraFailures = 2
      await pool.release(session)
      expect(session.browser).not.toBe(firstBrowser)
      expect(session.consecutiveInfraFailures).toBe(0)
    })

    it("never hands a condemned session to a waiter: the replacement completes first", async () => {
      let resolveReplacementFactory: ((browser: Browser) => void) | undefined
      const factory = vi
        .fn<() => Promise<Browser>>()
        .mockResolvedValueOnce(fakeBrowser())
        // The replacement browser's creation is held open so we can observe the waiter blocking.
        .mockImplementationOnce(
          () => new Promise<Browser>((resolve) => (resolveReplacementFactory = resolve)),
        )
      const pool = await createBrowserPool(1, factory, { recycleAfterStories: 1 })
      const session = await pool.acquire()
      const oldBrowser = session.browser
      session.storiesRendered = 1

      // A waiter queues while the (condemned) session is checked out.
      let acquired: PooledSession | undefined
      const waiting = pool.acquire().then((s) => (acquired = s))

      const releasing = pool.release(session)
      // Wait until release() has reached the (held-open) replacement factory call, then verify
      // the waiter has NOT been woken while the replacement is still being created.
      await vi.waitFor(() => expect(resolveReplacementFactory).toBeDefined())
      expect(acquired).toBeUndefined()

      const fresh = fakeBrowser()
      resolveReplacementFactory?.(fresh)
      await releasing
      await waiting
      expect(acquired).toBe(session)
      expect(acquired?.browser).toBe(fresh)
      expect(acquired?.browser).not.toBe(oldBrowser)
    })

    it("still returns the session (self-heal path) if the replacement fails on release", async () => {
      const factory = vi
        .fn<() => Promise<Browser>>()
        .mockResolvedValueOnce(fakeBrowser())
        .mockRejectedValue(new Error("create failed"))
      const pool = await createBrowserPool(1, factory, { recycleAfterStories: 1 })
      const session = await pool.acquire()
      session.storiesRendered = 1
      await expect(pool.release(session)).resolves.toBeUndefined()
      // The slot is back in the pool; the next renderer's probe will retry the replacement.
      await expect(pool.acquire()).resolves.toBe(session)
    })
  })

  it("destroyAll after a replace closes the current (replacement) browsers", async () => {
    const newDelete = vi.fn().mockResolvedValue(undefined)
    const newBrowser = { deleteSession: newDelete } as unknown as Browser
    const factory = vi
      .fn<() => Promise<Browser>>()
      .mockResolvedValueOnce(fakeBrowser())
      .mockResolvedValueOnce(newBrowser)
    const pool = await createBrowserPool(1, factory)
    const session = await pool.acquire()
    await pool.replace(session, "recycle")

    newDelete.mockClear()
    await pool.destroyAll()
    expect(newDelete).toHaveBeenCalledTimes(1)
    // Calling destroyAll twice is safe (timeout-abort + finally both call it).
    await expect(pool.destroyAll()).resolves.toBeUndefined()
  })
})
