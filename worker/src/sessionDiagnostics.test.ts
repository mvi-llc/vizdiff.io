import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  collectFailureDiagnostics,
  getConsoleEntries,
  getPendingRequestCount,
  getPendingRequests,
  installSessionDiagnostics,
  setCurrentStory,
} from "./sessionDiagnostics"
import { createMockBrowser, type MockBrowserResult } from "./testing/mockBrowser"

/**
 * Session failure diagnostics (issue #475): per-session BiDi log/network buffering with hard
 * caps, story tagging, and never-throwing best-effort collection. Each test uses a fresh mock
 * browser — the module's state is WeakMap-keyed on the Browser object, so a fresh mock isolates
 * state exactly like BrowserPool.replace() does in production.
 */
describe("sessionDiagnostics", () => {
  let mock: MockBrowserResult

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    mock = createMockBrowser()
    await installSessionDiagnostics(mock.browser)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function emitLog(text: string, extra: Record<string, unknown> = {}): void {
    mock.emitBidi("log.entryAdded", { level: "error", text, ...extra })
  }

  function emitRequest(requestId: string, url: string): void {
    mock.emitBidi("network.beforeRequestSent", { request: { request: requestId, url } })
  }

  it("subscribes to the log and network events once", () => {
    expect(mock.fns.sessionSubscribe).toHaveBeenCalledTimes(1)
    expect(mock.fns.sessionSubscribe).toHaveBeenCalledWith({
      events: [
        "log.entryAdded",
        "network.beforeRequestSent",
        "network.responseCompleted",
        "network.fetchError",
      ],
    })
  })

  it("swallows an install failure (BiDi unavailable) with a warning", async () => {
    const broken = createMockBrowser()
    broken.fns.sessionSubscribe.mockRejectedValueOnce(new Error("BiDi not supported"))

    await expect(installSessionDiagnostics(broken.browser)).resolves.toBeUndefined()
    // No handlers were installed; events are simply not buffered.
    broken.emitBidi("log.entryAdded", { level: "error", text: "lost" })
    expect(getConsoleEntries(broken.browser)).toHaveLength(0)
  })

  describe("console ring buffer", () => {
    it("caps the ring at 200 entries, dropping oldest", () => {
      for (let i = 1; i <= 250; i++) {
        emitLog(`entry ${i}`)
      }

      const entries = getConsoleEntries(mock.browser)
      expect(entries).toHaveLength(200)
      expect(entries[0]?.text).toBe("entry 51")
      expect(entries[199]?.text).toBe("entry 250")
    })

    it("truncates entry text to 500 chars and tolerates a null text", () => {
      emitLog("x".repeat(600))
      mock.emitBidi("log.entryAdded", { level: "warn", text: null })

      const entries = getConsoleEntries(mock.browser)
      expect(entries[0]?.text).toHaveLength(500)
      expect(entries[1]).toMatchObject({ level: "warn", text: "" })
    })

    it("stamps entries with the BiDi timestamp, falling back to Date.now()", () => {
      emitLog("with timestamp", { timestamp: 42 })
      emitLog("without timestamp")

      const entries = getConsoleEntries(mock.browser)
      expect(entries[0]?.stampMs).toBe(42)
      expect(entries[1]?.stampMs).toBe(1_000_000)
    })
  })

  describe("story tagging and tail filtering", () => {
    it("tags entries with the current story and filters the tail to it", async () => {
      // Entries logged while another story was current must not leak into this story's tail.
      setCurrentStory(mock.browser, "story-other")
      emitLog("other story noise")

      vi.setSystemTime(1_002_000)
      setCurrentStory(mock.browser, "story-a")
      emitLog("story-a exception")

      const diag = await collectFailureDiagnostics(mock.browser, "story-a", { screenshot: false })
      expect(diag.consoleTail).toHaveLength(1)
      expect(diag.consoleTail[0]).toMatchObject({
        text: "story-a exception",
        storyId: "story-a",
      })
    })

    it("includes untagged entries stamped at/after capture start, excludes older ones", async () => {
      // Untagged entry from before this capture attempt: excluded.
      emitLog("stale untagged", { timestamp: 999_000 })
      // Untagged entry stamped inside the capture window (e.g. delivered before the tag was
      // set): included.
      emitLog("fresh untagged", { timestamp: 1_003_000 })

      vi.setSystemTime(1_002_000)
      setCurrentStory(mock.browser, "story-a")

      const diag = await collectFailureDiagnostics(mock.browser, "story-a", { screenshot: false })
      expect(diag.consoleTail.map((entry) => entry.text)).toEqual(["fresh untagged"])
    })

    it("caps the tail at the 50 most recent matching entries", async () => {
      setCurrentStory(mock.browser, "story-a")
      for (let i = 1; i <= 80; i++) {
        emitLog(`entry ${i}`)
      }

      const diag = await collectFailureDiagnostics(mock.browser, "story-a", { screenshot: false })
      expect(diag.consoleTail).toHaveLength(50)
      expect(diag.consoleTail[0]?.text).toBe("entry 31")
      expect(diag.consoleTail[49]?.text).toBe("entry 80")
    })
  })

  describe("pending request tracking", () => {
    it("adds on beforeRequestSent and removes on responseCompleted/fetchError", () => {
      emitRequest("req-1", "http://localhost:1234/completed.js")
      emitRequest("req-2", "http://localhost:1234/errored.js")
      emitRequest("req-3", "http://localhost:1234/still-pending.js")
      mock.emitBidi("network.responseCompleted", { request: { request: "req-1" } })
      mock.emitBidi("network.fetchError", { request: { request: "req-2" } })

      const pending = getPendingRequests(mock.browser)
      expect(pending).toEqual([{ url: "http://localhost:1234/still-pending.js", pendingMs: 0 }])
    })

    it("reports age from start time, sorted longest-pending first, capped at 20", () => {
      for (let i = 1; i <= 25; i++) {
        emitRequest(`req-${i}`, `http://localhost:1234/asset-${i}.js`)
        vi.advanceTimersByTime(1000)
      }

      const pending = getPendingRequests(mock.browser)
      expect(pending).toHaveLength(20)
      // req-1 started first, so it has been pending longest (25s at collection time).
      expect(pending[0]).toEqual({ url: "http://localhost:1234/asset-1.js", pendingMs: 25_000 })
      expect(pending[19]?.pendingMs).toBe(6000)
      // An explicit `nowMs` shifts every age.
      expect(getPendingRequests(mock.browser, Date.now() + 1000)[0]?.pendingMs).toBe(26_000)
    })

    it("truncates reported URLs to 500 chars", () => {
      emitRequest("req-1", `http://localhost:1234/${"a".repeat(600)}`)

      expect(getPendingRequests(mock.browser)[0]?.url).toHaveLength(500)
    })

    it("evicts entries older than 5 minutes on insert", () => {
      emitRequest("req-old", "http://localhost:1234/leaked.js")
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      emitRequest("req-new", "http://localhost:1234/fresh.js")

      const pending = getPendingRequests(mock.browser)
      expect(pending).toHaveLength(1)
      expect(pending[0]?.url).toBe("http://localhost:1234/fresh.js")
    })

    it("caps the tracked map at 500 entries, evicting oldest-inserted", () => {
      for (let i = 1; i <= 501; i++) {
        emitRequest(`req-${i}`, `http://localhost:1234/asset-${i}.js`)
      }

      expect(getPendingRequestCount(mock.browser)).toBe(500)
      // req-1 was evicted; the survivors are req-2..req-501 (all same-age, so just check size
      // via the reported cap and absence of the first URL).
      const urls = getPendingRequests(mock.browser).map((p) => p.url)
      expect(urls).not.toContain("http://localhost:1234/asset-1.js")
    })
  })

  describe("failure-time screenshot", () => {
    it("captures and decodes the screenshot when requested", async () => {
      setCurrentStory(mock.browser, "story-a")

      const diag = await collectFailureDiagnostics(mock.browser, "story-a", { screenshot: true })

      expect(mock.fns.takeScreenshot).toHaveBeenCalledTimes(1)
      expect(diag.screenshotBuffer?.toString()).toBe("mock failure screenshot data")
    })

    it("skips the screenshot when the flag is false", async () => {
      const diag = await collectFailureDiagnostics(mock.browser, "story-a", { screenshot: false })

      expect(mock.fns.takeScreenshot).not.toHaveBeenCalled()
      expect(diag.screenshotBuffer).toBeUndefined()
    })

    it("gives up on the screenshot when it exceeds the timeout (partial data returned)", async () => {
      setCurrentStory(mock.browser, "story-a")
      emitLog("still have console context")
      // A wedged session: takeScreenshot never settles.
      mock.fns.takeScreenshot.mockImplementationOnce(() => new Promise(() => undefined))

      const pending = collectFailureDiagnostics(mock.browser, "story-a", {
        screenshot: true,
        screenshotTimeoutMs: 5000,
      })
      await vi.advanceTimersByTimeAsync(5000)
      const diag = await pending

      expect(diag.screenshotBuffer).toBeUndefined()
      expect(diag.consoleTail.map((entry) => entry.text)).toEqual(["still have console context"])
    })
  })

  describe("collect never throws", () => {
    it("returns partial data when takeScreenshot rejects", async () => {
      setCurrentStory(mock.browser, "story-a")
      emitLog("boom context")
      emitRequest("req-1", "http://localhost:1234/pending.js")
      mock.fns.takeScreenshot.mockRejectedValueOnce(new Error("screenshot exploded"))

      const diag = await collectFailureDiagnostics(mock.browser, "story-a", { screenshot: true })

      expect(diag.screenshotBuffer).toBeUndefined()
      expect(diag.consoleTail).toHaveLength(1)
      expect(diag.pendingRequests).toHaveLength(1)
    })

    it("returns empty diagnostics for a browser with no installed state", async () => {
      const fresh = createMockBrowser()

      const diag = await collectFailureDiagnostics(fresh.browser, "story-a", {
        screenshot: false,
      })

      expect(diag).toEqual({ consoleTail: [], pendingRequests: [] })
    })
  })
})
