import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Browser } from "webdriverio"

import { log } from "./log"
import {
  DISABLE_WEBGL_CHROME_ARGS,
  ENABLE_WEBGL_CHROME_ARGS,
  HARDENING_CHROME_ARGS,
  RESOLVER_EGRESS_CHROME_ARGS,
  hardenedChromeArgs,
  installBrowserSafeguards,
  installNetworkEgressBlock,
  safeguardInitScript,
} from "./safeguards"

vi.mock("./log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

describe("hardenedChromeArgs", () => {
  it("appends all hardening flags to the base args", () => {
    const base = ["--headless", "--no-sandbox"]
    const result = hardenedChromeArgs(base)
    expect(result.slice(0, 2)).toEqual(base)
    for (const flag of HARDENING_CHROME_ARGS) {
      expect(result).toContain(flag)
    }
  })

  it("disables WebRTC", () => {
    expect(hardenedChromeArgs([])).toContain("--disable-webrtc")
  })

  it("de-duplicates flags while preserving order", () => {
    const result = hardenedChromeArgs(["--headless", "--disable-webrtc"])
    expect(result.filter((a) => a === "--disable-webrtc")).toHaveLength(1)
    expect(result[0]).toBe("--headless")
  })

  it("disables WebGL by default", () => {
    const result = hardenedChromeArgs([])
    for (const flag of DISABLE_WEBGL_CHROME_ARGS) {
      expect(result).toContain(flag)
    }
    for (const flag of ENABLE_WEBGL_CHROME_ARGS) {
      expect(result).not.toContain(flag)
    }
  })

  it("swaps to the software-WebGL flags when enableWebgl is set", () => {
    const result = hardenedChromeArgs([], { enableWebgl: true })
    for (const flag of ENABLE_WEBGL_CHROME_ARGS) {
      expect(result).toContain(flag)
    }
    for (const flag of DISABLE_WEBGL_CHROME_ARGS) {
      expect(result).not.toContain(flag)
    }
  })

  it("appends the resolver egress rules when egressBlockMode is resolver", () => {
    const result = hardenedChromeArgs([], { egressBlockMode: "resolver" })
    for (const flag of RESOLVER_EGRESS_CHROME_ARGS) {
      expect(result).toContain(flag)
    }
  })

  it("omits the resolver egress rules for the other egress modes and by default", () => {
    for (const args of [
      hardenedChromeArgs([]),
      hardenedChromeArgs([], { egressBlockMode: "intercept" }),
      hardenedChromeArgs([], { egressBlockMode: "off" }),
    ]) {
      for (const flag of RESOLVER_EGRESS_CHROME_ARGS) {
        expect(args).not.toContain(flag)
      }
    }
  })

  it("appends operator extra args last", () => {
    const result = hardenedChromeArgs(["--headless"], {
      extraArgs: ["--force-color-profile=srgb", "--lang=de"],
    })
    expect(result.slice(-2)).toEqual(["--force-color-profile=srgb", "--lang=de"])
  })

  it("de-duplicates extra args against earlier flags without reordering them", () => {
    const result = hardenedChromeArgs(["--headless"], {
      extraArgs: ["--disable-webrtc", "--lang=de"],
    })
    expect(result.filter((a) => a === "--disable-webrtc")).toHaveLength(1)
    expect(result.indexOf("--disable-webrtc")).toBeLessThan(result.indexOf("--lang=de"))
  })
})

describe("installBrowserSafeguards", () => {
  it("installs the init script via addInitScript", async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined)
    const browser = { addInitScript } as unknown as Browser
    await installBrowserSafeguards(browser)
    expect(addInitScript).toHaveBeenCalledWith(safeguardInitScript)
  })

  it("does not throw if addInitScript fails (BiDi unavailable)", async () => {
    const addInitScript = vi.fn().mockRejectedValue(new Error("no BiDi"))
    const browser = { addInitScript } as unknown as Browser
    await expect(installBrowserSafeguards(browser)).resolves.toBeUndefined()
  })
})

/**
 * Exercises the page init script against a minimal fake `window`, simulating the
 * browser environment so we can assert the runtime safeguard behavior without a
 * real browser.
 */
describe("safeguardInitScript (page behavior)", () => {
  class FakeDOMException extends Error {
    constructor(
      message: string,
      public override name: string,
    ) {
      super(message)
    }
  }

  function makeWindow(origin: string) {
    const calls = { assign: [] as string[], replace: [] as string[], open: [] as string[] }
    const fetchCalls: string[] = []
    const xhrOpenCalls: string[] = []

    const win: Record<string, unknown> = {
      URL,
      Promise,
      DOMException: FakeDOMException,
      location: {
        href: `${origin}/iframe.html`,
        origin,
        assign: (url: string) => calls.assign.push(url),
        replace: (url: string) => calls.replace.push(url),
      },
      open: (url?: string) => {
        calls.open.push(String(url))
        return null
      },
      WebSocket: class RealWS {
        connected = true
      },
      WebTransport: class RealWT {
        ready = true
      },
      RTCPeerConnection: class RealRTC {
        ready = true
      },
      EventSource: class RealES {
        open = true
      },
      fetch: (input: unknown) => {
        fetchCalls.push(typeof input === "string" ? input : String((input as { url?: string }).url))
        return Promise.resolve("ok")
      },
      XMLHttpRequest: class {
        open(_method: string, url: string) {
          xhrOpenCalls.push(url)
        }
      },
      navigator: { sendBeacon: () => true },
    }
    return { win, calls, fetchCalls, xhrOpenCalls }
  }

  function run(origin: string) {
    const ctx = makeWindow(origin)
    // Run the init script with our fake window installed as a global.
    const g = globalThis as unknown as { window?: unknown }
    const prev = g.window
    g.window = ctx.win
    try {
      safeguardInitScript()
    } finally {
      if (prev == undefined) {
        delete g.window
      } else {
        g.window = prev
      }
    }
    return ctx
  }

  const ORIGIN = "http://localhost:5000"

  it("does not attempt to override location.assign/replace", () => {
    // location.assign/replace are non-configurable own properties in Chrome and
    // cannot be overridden from page JS; off-origin navigation is blocked at the
    // network layer (installNetworkEgressBlock) instead. The init script must
    // leave them untouched (no crash, original references preserved).
    const ctx = run(ORIGIN)
    const loc = ctx.win.location as { assign: (u: string) => void; replace: (u: string) => void }
    loc.assign("https://evil.example.com/x")
    loc.replace("https://evil.example.com/y")
    // The init script left the originals in place, so these calls pass through
    // unchanged (they are recorded, NOT filtered by the init script).
    expect(ctx.calls.assign).toEqual(["https://evil.example.com/x"])
    expect(ctx.calls.replace).toEqual(["https://evil.example.com/y"])
  })

  it("blocks window.open to off-origin URLs", () => {
    const ctx = run(ORIGIN)
    ;(ctx.win.open as (u: string) => unknown)("https://evil.example.com")
    ;(ctx.win.open as (u: string) => unknown)(`${ORIGIN}/ok`)
    expect(ctx.calls.open).toEqual([`${ORIGIN}/ok`])
  })

  it("disables real-time transports (throws on construct)", () => {
    const ctx = run(ORIGIN)
    for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "EventSource"]) {
      const Ctor = ctx.win[name] as new () => unknown
      expect(() => new Ctor()).toThrow(/safeguards/)
    }
  })

  it("makes the transport globals non-configurable so page scripts cannot restore them", () => {
    const ctx = run(ORIGIN)
    for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "EventSource"]) {
      const descriptor = Object.getOwnPropertyDescriptor(ctx.win, name)
      expect(descriptor?.configurable).toBe(false)
      expect(descriptor?.writable).toBe(false)
      // A later page script trying to reassign must not defeat the guard.
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(ctx.win as any)[name] = function Evil() {
          return undefined
        }
      }).toThrow()
      const Ctor = ctx.win[name] as new () => unknown
      expect(() => new Ctor()).toThrow(/safeguards/)
    }
  })

  it("blocks off-origin fetch but allows same-origin and relative", async () => {
    const ctx = run(ORIGIN)
    const f = ctx.win.fetch as (input: unknown) => Promise<unknown>
    await expect(f("https://evil.example.com/data")).rejects.toThrow(/off-origin fetch/)
    await expect(f(`${ORIGIN}/asset.js`)).resolves.toBe("ok")
    await expect(f("/relative.css")).resolves.toBe("ok")
    expect(ctx.fetchCalls).toEqual([`${ORIGIN}/asset.js`, "/relative.css"])
  })

  it("blocks off-origin XMLHttpRequest.open but allows same-origin", () => {
    const ctx = run(ORIGIN)
    const Xhr = ctx.win.XMLHttpRequest as new () => { open: (m: string, u: string) => void }
    const xhr = new Xhr()
    expect(() => xhr.open("GET", "https://evil.example.com/x")).toThrow(/off-origin XMLHttpRequest/)
    expect(() => xhr.open("GET", `${ORIGIN}/ok`)).not.toThrow()
    expect(ctx.xhrOpenCalls).toEqual([`${ORIGIN}/ok`])
  })

  it("neuters navigator.sendBeacon", () => {
    const ctx = run(ORIGIN)
    const nav = ctx.win.navigator as { sendBeacon: (url: string) => boolean }
    expect(nav.sendBeacon("https://evil.example.com")).toBe(false)
  })
})

describe("installNetworkEgressBlock", () => {
  const ALLOWED = "http://localhost:6230"

  beforeEach(() => {
    vi.clearAllMocks()
  })

  type Handler = (event: unknown) => void

  function makeBrowser() {
    const continued: string[] = []
    const failed: string[] = []
    let handler: Handler | undefined
    const browser = {
      networkAddIntercept: vi.fn().mockResolvedValue({ intercept: "id" }),
      sessionSubscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, fn: Handler) => {
        if (event === "network.beforeRequestSent") {
          handler = fn
        }
      }),
      networkContinueRequest: vi.fn((p: { request: string }) => {
        continued.push(p.request)
        return Promise.resolve()
      }),
      networkFailRequest: vi.fn((p: { request: string }) => {
        failed.push(p.request)
        return Promise.resolve()
      }),
    }
    const emit = (requestId: string, url: string) =>
      handler?.({ request: { request: requestId, url } })
    return { browser, continued, failed, emit }
  }

  /** Waits out the handler's fire-and-forget settle chain (incl. the 100 ms release retry). */
  const flushSettle = () => new Promise((resolve) => setTimeout(resolve, 200))

  it("installs nothing in resolver mode (enforcement lives in the Chrome launch args)", async () => {
    const { browser } = makeBrowser()
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "resolver")
    expect(browser.networkAddIntercept).not.toHaveBeenCalled()
    expect(browser.sessionSubscribe).not.toHaveBeenCalled()
    expect(browser.on).not.toHaveBeenCalled()
  })

  it("defaults to resolver mode when no mode is given", async () => {
    const { browser } = makeBrowser()
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED)
    expect(browser.networkAddIntercept).not.toHaveBeenCalled()
  })

  it("installs nothing in off mode and warns about the disabled safeguard", async () => {
    const { browser } = makeBrowser()
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "off")
    expect(browser.networkAddIntercept).not.toHaveBeenCalled()
    expect(browser.sessionSubscribe).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("DISABLED"))
  })

  it("subscribes to beforeRequestSent and adds an intercept in intercept mode", async () => {
    const { browser } = makeBrowser()
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept")
    expect(browser.networkAddIntercept).toHaveBeenCalledWith({ phases: ["beforeRequestSent"] })
    expect(browser.sessionSubscribe).toHaveBeenCalledWith({
      events: ["network.beforeRequestSent"],
    })
    expect(browser.on).toHaveBeenCalledWith("network.beforeRequestSent", expect.any(Function))
  })

  it("continues same-origin requests and fails off-origin ones", async () => {
    const { browser, continued, failed, emit } = makeBrowser()
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept")

    emit("r1", `${ALLOWED}/iframe.html`) // same-origin -> allow
    emit("r2", `${ALLOWED}/static/main.js`) // same-origin -> allow
    emit("r3", "https://evil.example.com/steal?x=1") // off-origin -> fail
    emit("r4", "wss://evil.example.com/socket") // off-origin -> fail
    emit("r5", "data:text/plain,hi") // non-network scheme -> allow
    emit("r6", "blob:http://localhost:6230/abc") // blob -> allow

    expect(continued).toEqual(["r1", "r2", "r5", "r6"])
    expect(failed).toEqual(["r3", "r4"])
  })

  it("ignores events without a request id", async () => {
    const { browser, continued, failed, emit } = makeBrowser()
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept")
    // @ts-expect-error intentionally malformed event
    emit(undefined, "https://evil.example.com")
    expect(continued).toEqual([])
    expect(failed).toEqual([])
  })

  it("does not throw if BiDi is unavailable", async () => {
    const browser = {
      networkAddIntercept: vi.fn().mockRejectedValue(new Error("no BiDi")),
      sessionSubscribe: vi.fn(),
      on: vi.fn(),
    }
    await expect(
      installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept"),
    ).resolves.toBeUndefined()
  })

  it("warns once per URL key when an allowed request cannot be settled (issue #473)", async () => {
    const { browser, emit } = makeBrowser()
    const wedged = new Error("'Fetch.continueRequest' wasn't found")
    browser.networkContinueRequest.mockRejectedValue(wedged)
    browser.networkFailRequest.mockRejectedValue(wedged)
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept")

    // Two copies of the same asset (different cache-busting query) plus one distinct asset.
    emit("r1", `${ALLOWED}/assets/font.woff2?copy=1`)
    emit("r2", `${ALLOWED}/assets/font.woff2?copy=2`)
    emit("r3", `${ALLOWED}/assets/other.js`)
    await flushSettle()

    const warns = vi
      .mocked(log.warn)
      .mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("could not settle"))
    expect(warns).toHaveLength(2) // one per URL-sans-query, not one per request
    // The message must be actionable: point the operator at resolver mode.
    expect(warns[0]?.[1]).toContain("WORKER_EGRESS_BLOCK_MODE=resolver")
  })

  it("attempts a best-effort release before warning and reports success", async () => {
    const { browser, emit } = makeBrowser()
    browser.networkContinueRequest.mockRejectedValue(new Error("transient"))
    // networkFailRequest succeeds -> the paused request is at least released (as failed).
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept")

    emit("r1", `${ALLOWED}/assets/font.woff2`)
    await flushSettle()

    expect(browser.networkFailRequest).toHaveBeenCalledWith({ request: "r1" })
    const warns = vi
      .mocked(log.warn)
      .mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("could not settle"))
    expect(warns).toHaveLength(1)
    expect(warns[0]?.[1]).toContain("released on retry")
  })

  it("errors when a BLOCK could not be enforced", async () => {
    const { browser, emit } = makeBrowser()
    const wedged = new Error("'Fetch.failRequest' wasn't found")
    browser.networkFailRequest.mockRejectedValue(wedged)
    await installNetworkEgressBlock(browser as unknown as Browser, ALLOWED, "intercept")

    emit("r1", "https://evil.example.com/steal")
    emit("r2", "https://evil.example.com/steal")
    await flushSettle()

    const errors = vi
      .mocked(log.error)
      .mock.calls.filter(
        ([, msg]) => typeof msg === "string" && msg.includes("could NOT enforce the block"),
      )
    // Security-relevant: every unenforced block is error-level, no dedupe.
    expect(errors).toHaveLength(2)
  })
})
