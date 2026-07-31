import type { Counter, Gauge, Histogram } from "prom-client"
import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  metricsRegistry,
  recordBrowserRelaunch,
  recordBuildOutcome,
  recordStoryPhaseDuration,
  recordStoryResult,
  resetMetricsStateForTest,
} from "./metrics"

const mockQuery = vi.fn()
const mockRelease = vi.fn()

vi.mock("./database", () => ({
  DatabasePool: vi.fn(async () => ({ query: mockQuery, release: mockRelease })),
}))

/** Value entries for a metric, via the registry (triggers the metric's collect(), if any). */
async function metricValues(
  name: string,
): Promise<{ value: number; labels: Record<string, string | number> }[]> {
  const metric = metricsRegistry.getSingleMetric(name) as Counter | Gauge | Histogram | undefined
  expect(metric).toBeDefined()
  const { values } = await metric!.get()
  return values as { value: number; labels: Record<string, string | number> }[]
}

async function labeledValue(
  name: string,
  labels: Record<string, string>,
): Promise<number | undefined> {
  const values = await metricValues(name)
  return values.find((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    ?.value
}

describe("worker metrics (#457)", () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [{ depth: 0 }], rowCount: 1 })
    mockRelease.mockReset()
    resetMetricsStateForTest()
  })

  describe("recordBuildOutcome", () => {
    it("increments builds_total by outcome and observes the duration histogram", async () => {
      recordBuildOutcome("completed", 90)
      recordBuildOutcome("completed", 400)
      recordBuildOutcome("failed", 10)
      recordBuildOutcome("aborted", 1500)

      expect(await labeledValue("vizdiff_worker_builds_total", { outcome: "completed" })).toBe(2)
      expect(await labeledValue("vizdiff_worker_builds_total", { outcome: "failed" })).toBe(1)
      expect(await labeledValue("vizdiff_worker_builds_total", { outcome: "aborted" })).toBe(1)

      const values = await metricValues("vizdiff_worker_build_duration_seconds")
      const count = values.find(
        (v) => v.labels.le == undefined && !("quantile" in v.labels) && v.value === 4,
      )
      expect(count).toBeDefined()
      // 90 s falls in the le=120 bucket but not le=60.
      const le60 = values.find((v) => v.labels.le === 60)
      const le120 = values.find((v) => v.labels.le === 120)
      expect(le60?.value).toBe(1) // only the 10 s build
      expect(le120?.value).toBe(2) // 10 s + 90 s
    })
  })

  describe("recordStoryResult", () => {
    it("maps non-failed results to ok", async () => {
      recordStoryResult({ changeStatus: "unchanged", errorKind: null })
      recordStoryResult({ changeStatus: "new" })
      expect(await labeledValue("vizdiff_worker_stories_total", { outcome: "ok" })).toBe(2)
    })

    it("maps failed results via isInfraErrorKind to infra_error vs story_error", async () => {
      recordStoryResult({ changeStatus: "failed", errorKind: "browser-gone" })
      recordStoryResult({ changeStatus: "failed", errorKind: "storage" })
      recordStoryResult({ changeStatus: "failed", errorKind: "story-error" })
      recordStoryResult({ changeStatus: "failed", errorKind: "unknown" })

      expect(await labeledValue("vizdiff_worker_stories_total", { outcome: "infra_error" })).toBe(2)
      expect(await labeledValue("vizdiff_worker_stories_total", { outcome: "story_error" })).toBe(2)
    })
  })

  describe("recordStoryPhaseDuration", () => {
    it("observes per-phase histograms", async () => {
      recordStoryPhaseDuration("capture", 3)
      recordStoryPhaseDuration("capture", 45)
      recordStoryPhaseDuration("finalize", 0.7)

      const values = await metricValues("vizdiff_worker_story_duration_seconds")
      const captureLe5 = values.find((v) => v.labels.phase === "capture" && v.labels.le === 5)
      const captureLe60 = values.find((v) => v.labels.phase === "capture" && v.labels.le === 60)
      const finalizeLe1 = values.find((v) => v.labels.phase === "finalize" && v.labels.le === 1)
      expect(captureLe5?.value).toBe(1)
      expect(captureLe60?.value).toBe(2)
      expect(finalizeLe1?.value).toBe(1)
    })
  })

  describe("recordBrowserRelaunch", () => {
    it("increments the relaunch counter", async () => {
      recordBrowserRelaunch()
      recordBrowserRelaunch()
      const values = await metricValues("vizdiff_worker_browser_relaunches_total")
      expect(values[0]?.value).toBe(2)
    })
  })

  describe("queue depth gauge", () => {
    it("collects the claimable-task count from the database on scrape", async () => {
      mockQuery.mockResolvedValue({ rows: [{ depth: 7 }], rowCount: 1 })

      const values = await metricValues("vizdiff_worker_queue_depth")
      expect(values[0]?.value).toBe(7)

      const [sql] = mockQuery.mock.calls[0] as [string]
      expect(sql).toContain("FROM task_queue")
      expect(sql).toMatch(/locked_at IS NULL/)
      // Mirrors the claim expiry window (WORKER_TASK_LOCK_TIMEOUT_MINUTES, default 10).
      expect(sql).toMatch(/locked_at < NOW\(\) - INTERVAL '10 minutes'/)
      expect(mockRelease).toHaveBeenCalledTimes(1)
    })

    it("serves the last-known value when the query fails", async () => {
      mockQuery.mockResolvedValue({ rows: [{ depth: 3 }], rowCount: 1 })
      expect((await metricValues("vizdiff_worker_queue_depth"))[0]?.value).toBe(3)

      mockQuery.mockRejectedValue(new Error("db down"))
      expect((await metricValues("vizdiff_worker_queue_depth"))[0]?.value).toBe(3)
    })

    it("times out a hung query after 2 s and serves the last-known value", async () => {
      vi.useFakeTimers()
      try {
        mockQuery.mockResolvedValue({ rows: [{ depth: 5 }], rowCount: 1 })
        expect((await metricValues("vizdiff_worker_queue_depth"))[0]?.value).toBe(5)

        // The next scrape hits a query that never settles: the 2 s guard must resolve the
        // collect (with the previous value) instead of hanging the scrape.
        mockQuery.mockImplementation(() => new Promise(() => undefined))
        const pending = metricValues("vizdiff_worker_queue_depth")
        await vi.advanceTimersByTimeAsync(2_000)
        expect((await pending)[0]?.value).toBe(5)
      } finally {
        vi.useRealTimers()
      }
    })

    it("reports prom-client's initial 0 when depth was never observed", async () => {
      mockQuery.mockRejectedValue(new Error("db down"))
      const values = await metricValues("vizdiff_worker_queue_depth")
      expect(values[0]?.value).toBe(0)
    })
  })

  describe("exposition", () => {
    it("renders the Prometheus text format with the vizdiff_worker_ metrics", async () => {
      recordBuildOutcome("completed", 60)
      const text = await metricsRegistry.metrics()
      expect(text).toContain('vizdiff_worker_builds_total{outcome="completed"} 1')
      expect(text).toContain("# TYPE vizdiff_worker_build_duration_seconds histogram")
      expect(text).toContain("# TYPE vizdiff_worker_queue_depth gauge")
      expect(text).toContain("# TYPE vizdiff_worker_last_story_completed_timestamp gauge")
      // Default Node.js process metrics are prefixed.
      expect(text).toContain("vizdiff_worker_process_cpu_user_seconds_total")
    })
  })
})
