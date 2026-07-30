import { afterEach, describe, expect, it, vi } from "vitest"
import type { Browser } from "webdriverio"

import { probeSession } from "./sessionHealth"

vi.mock("./log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

afterEach(() => {
  vi.useRealTimers()
})

describe("probeSession", () => {
  it("returns true when the trivial execute resolves promptly", async () => {
    const browser = { execute: vi.fn().mockResolvedValue(1) } as unknown as Browser
    await expect(probeSession(browser)).resolves.toBe(true)
  })

  it("returns false when execute rejects (dead session)", async () => {
    const browser = {
      execute: vi.fn().mockRejectedValue(new Error("invalid session id")),
    } as unknown as Browser
    await expect(probeSession(browser)).resolves.toBe(false)
  })

  it("returns false when execute throws synchronously", async () => {
    const browser = {
      execute: vi.fn(() => {
        throw new Error("client torn down")
      }),
    } as unknown as Browser
    await expect(probeSession(browser)).resolves.toBe(false)
  })

  it("returns false when execute hangs past the probe timeout (default 5 s)", async () => {
    vi.useFakeTimers()
    const browser = {
      execute: vi.fn(() => new Promise(() => undefined)), // never settles
    } as unknown as Browser

    let result: boolean | undefined
    const probing = probeSession(browser).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await probing
    expect(result).toBe(false)
  })

  it("honors an explicit timeout override", async () => {
    vi.useFakeTimers()
    const browser = {
      execute: vi.fn(() => new Promise(() => undefined)),
    } as unknown as Browser
    const probing = probeSession(browser, 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(probing).resolves.toBe(false)
  })
})
