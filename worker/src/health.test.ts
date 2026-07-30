import type http from "node:http"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { WORKER_PROGRESS_TIMEOUT_MS } from "./environment"
import { healthRequestHandler } from "./health"
import { beginBuildProgress, endBuildProgress } from "./progress"

const mockQuery = vi.fn()
const mockRelease = vi.fn()

vi.mock("./database", () => ({
  DatabasePool: vi.fn(async () => ({ query: mockQuery, release: mockRelease })),
}))

interface InvokedResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

/** Drive the exported request handler directly with a minimal req/res pair. */
function invoke(url: string): Promise<InvokedResponse> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {}
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string): void {
        headers[name] = value
      },
      end(body?: unknown): void {
        resolve({
          statusCode: this.statusCode,
          headers,
          body: typeof body === "string" ? body : "",
        })
      },
    }
    healthRequestHandler({ url } as http.IncomingMessage, res as unknown as http.ServerResponse)
  })
}

describe("worker health endpoints (#457)", () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [{ depth: 0 }], rowCount: 1 })
    mockRelease.mockReset()
  })
  afterEach(() => {
    endBuildProgress()
    vi.useRealTimers()
  })

  it("GET /health reports ok with a null progress snapshot when no build is active", async () => {
    const res = await invoke("/health")
    expect(res.statusCode).toBe(200)
    expect(res.headers["Content-Type"]).toBe("application/json")
    const payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload.status).toBe("ok")
    expect(payload.degradedReason).toBeUndefined()
    expect(payload.progress).toBeNull()
  })

  it("GET /health includes the active build's progress snapshot", async () => {
    vi.useFakeTimers()
    const progress = beginBuildProgress(42, 10)
    progress.completeStory()
    await vi.advanceTimersByTimeAsync(0) // flush the fire-and-forget heartbeat

    const res = await invoke("/health")
    const payload = JSON.parse(res.body) as {
      status: string
      progress: {
        activeBuildId: number
        expectedStories: number
        completedStories: number
        lastStoryCompletedAt: number
      }
    }
    expect(payload.status).toBe("ok")
    expect(payload.progress).toEqual({
      activeBuildId: 42,
      expectedStories: 10,
      completedStories: 1,
      lastStoryCompletedAt: Date.now(),
    })
  })

  it("GET /health flips to degraded (still HTTP 200) when an active build stalls", async () => {
    vi.useFakeTimers()
    beginBuildProgress(42, 10)

    // Just inside the watchdog window: still ok.
    await vi.advanceTimersByTimeAsync(WORKER_PROGRESS_TIMEOUT_MS)
    let payload = JSON.parse((await invoke("/health")).body) as Record<string, unknown>
    expect(payload.status).toBe("ok")

    // Past the window with no story progress: degraded — but STILL HTTP 200, because the
    // liveness probe must not restart the pod over a stalled build (the in-process watchdog
    // owns that failure path).
    await vi.advanceTimersByTimeAsync(1_000)
    const res = await invoke("/health")
    expect(res.statusCode).toBe(200)
    payload = JSON.parse(res.body) as Record<string, unknown>
    expect(payload.status).toBe("degraded")
    expect(payload.degradedReason).toMatch(/build 42 has made no progress/)

    // Story progress clears the degraded state.
    const progress = beginBuildProgress(43, 10)
    progress.touch()
    payload = JSON.parse((await invoke("/health")).body) as Record<string, unknown>
    expect(payload.status).toBe("ok")
  })

  it("GET /health/live always returns a bare 200, even when a build is stalled", async () => {
    vi.useFakeTimers()
    beginBuildProgress(42, 10)
    await vi.advanceTimersByTimeAsync(WORKER_PROGRESS_TIMEOUT_MS + 60_000)

    const res = await invoke("/health/live")
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe("ok")
  })

  it("GET /metrics serves the Prometheus exposition format", async () => {
    const res = await invoke("/metrics")
    expect(res.statusCode).toBe(200)
    expect(res.headers["Content-Type"]).toContain("text/plain")
    expect(res.body).toContain("vizdiff_worker_builds_total")
    expect(res.body).toContain("vizdiff_worker_queue_depth")
  })

  it("unknown paths return 404", async () => {
    const res = await invoke("/nope")
    expect(res.statusCode).toBe(404)
  })
})
