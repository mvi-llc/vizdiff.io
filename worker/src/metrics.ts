import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client"
import { isInfraErrorKind } from "shared"

import { DatabasePool } from "./database"
import { WORKER_TASK_LOCK_TIMEOUT_MINUTES } from "./environment"
import { log } from "./log"
import { getCurrentBuildProgress } from "./progress"

/**
 * Prometheus metrics for the worker (issue #457).
 *
 * A worker once crash-looped 44 times over 14 hours (browser OOM → wedged session → build
 * timeout → FATAL exit) and the only signal was users reporting stuck builds. These metrics turn
 * the wedge signatures into one-line alert rules: an `infra_error` spike in
 * `vizdiff_worker_stories_total` is the dead-session signature, story-duration p95 pinned at the
 * 60 s command timeout means the browser is dead, and a stale
 * `vizdiff_worker_last_story_completed_timestamp` while a build is running means the build is
 * wedged.
 *
 * This module owns the registry and every metric object; call sites use the exported record
 * functions so instrumentation stays a one-line concern at each seam. The registry is served by
 * health.ts at GET /metrics. Metrics are always on — no env gate — because an idle registry
 * costs nothing.
 */

export const metricsRegistry = new Registry()

collectDefaultMetrics({ register: metricsRegistry, prefix: "vizdiff_worker_" })

export type BuildOutcome = "completed" | "failed" | "aborted"
export type StoryOutcome = "ok" | "infra_error" | "story_error"
export type StoryPhase = "capture" | "finalize"

const buildsTotal = new Counter({
  name: "vizdiff_worker_builds_total",
  help: "Builds processed by this worker, by outcome (aborted = build timeout/stall watchdog).",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
})

const buildDurationSeconds = new Histogram({
  name: "vizdiff_worker_build_duration_seconds",
  help: "Wall-clock duration of build ingestion (download through render/finalize).",
  buckets: [30, 60, 120, 300, 600, 1200, 1800],
  registers: [metricsRegistry],
})

const storiesTotal = new Counter({
  name: "vizdiff_worker_stories_total",
  help:
    "Stories processed, by outcome. A spike in infra_error (dead browser session, command " +
    "timeout, storage) is the wedged-session signature.",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
})

const storyDurationSeconds = new Histogram({
  name: "vizdiff_worker_story_duration_seconds",
  help:
    "Per-story phase duration. capture = navigate/stabilize/screenshot (browser held); " +
    "finalize = S3 uploads + baseline diff + DB save. capture p95 pinned at the 60 s command " +
    "timeout means the browser is dead.",
  labelNames: ["phase"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
})

const browserRelaunchesTotal = new Counter({
  name: "vizdiff_worker_browser_relaunches_total",
  help: "Pooled browser sessions replaced (dead-session probe, infra failures, or recycling).",
  registers: [metricsRegistry],
})

/** Record a finished build. `durationSec` is the wall-clock ingest duration in seconds. */
export function recordBuildOutcome(outcome: BuildOutcome, durationSec: number): void {
  buildsTotal.inc({ outcome })
  buildDurationSeconds.observe(durationSec)
}

/**
 * Record one story's final recorded TestResult: ok when not failed, otherwise classified
 * infra_error vs story_error from the recorded error kind (issue #454) via the shared
 * `isInfraErrorKind` predicate.
 */
export function recordStoryResult(result: {
  changeStatus: string
  errorKind?: string | null
}): void {
  const outcome: StoryOutcome =
    result.changeStatus !== "failed"
      ? "ok"
      : isInfraErrorKind(result.errorKind)
        ? "infra_error"
        : "story_error"
  storiesTotal.inc({ outcome })
}

/** Record how long one story spent in a pipeline phase. */
export function recordStoryPhaseDuration(phase: StoryPhase, durationSec: number): void {
  storyDurationSeconds.observe({ phase }, durationSec)
}

/** Called from browserPool.replace(): one pooled Chrome session was torn down and relaunched. */
export function recordBrowserRelaunch(): void {
  browserRelaunchesTotal.inc()
}

/** How long a scrape will wait on the queue-depth query before serving the last-known value. */
const QUEUE_DEPTH_QUERY_TIMEOUT_MS = 2000

let lastKnownQueueDepth: number | undefined

/**
 * Count claimable tasks (unlocked, or whose lock has expired), bounded by a short timeout so a
 * slow/down database can never hang a Prometheus scrape. Returns undefined on failure/timeout;
 * the abandoned query settles in the background and its client is always released.
 */
async function queryQueueDepth(): Promise<number | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUEUE_DEPTH_QUERY_TIMEOUT_MS)
    timer.unref()
  })
  const query = (async () => {
    const client = await DatabasePool()
    try {
      // Mirrors the availability window used by the task scheduler (tasks.ts claimNextTask):
      // a task whose lock outlived WORKER_TASK_LOCK_TIMEOUT_MINUTES is claimable again.
      const res = await client.query(
        `SELECT count(*)::int AS depth FROM task_queue
         WHERE locked_at IS NULL
            OR locked_at < NOW() - INTERVAL '${WORKER_TASK_LOCK_TIMEOUT_MINUTES} minutes'`,
      )
      return (res.rows[0] as { depth: number } | undefined)?.depth
    } finally {
      client.release()
    }
  })()
  // Observe the query's eventual rejection even when the timeout wins the race, so an abandoned
  // slow query never becomes an unhandled rejection.
  const observed = query.catch((err: unknown) => {
    log.debug(err, "metrics: queue depth query failed")
    return undefined
  })
  try {
    return await Promise.race([observed, timeout])
  } finally {
    clearTimeout(timer)
  }
}

new Gauge({
  name: "vizdiff_worker_queue_depth",
  help: "Claimable tasks in task_queue (unlocked or lock expired). Sampled at scrape time.",
  registers: [metricsRegistry],
  async collect() {
    const depth = await queryQueueDepth()
    if (depth != undefined) {
      lastKnownQueueDepth = depth
    }
    // On query failure/timeout serve the last-known value (or prom-client's initial 0 on a cold
    // start) rather than failing or hanging the whole scrape.
    if (lastKnownQueueDepth != undefined) {
      this.set(lastKnownQueueDepth)
    }
  },
})

let lastStoryCompletedAtMs: number | undefined

/**
 * Test-only hook: metrics module state persists across tests in one process, so tests reset the
 * sticky values explicitly.
 */
export function resetMetricsStateForTest(): void {
  lastKnownQueueDepth = undefined
  lastStoryCompletedAtMs = undefined
  metricsRegistry.resetMetrics()
}

new Gauge({
  name: "vizdiff_worker_last_story_completed_timestamp",
  help:
    "Unix time (seconds) of the last observed story progress. `time() - this > threshold` " +
    "while a build is active is the one-line wedged-build alert.",
  registers: [metricsRegistry],
  collect() {
    const progress = getCurrentBuildProgress()
    if (progress) {
      // lastProgressAtMs starts at build start, so the gauge is fresh while a healthy build
      // renders and goes stale exactly when the build wedges.
      lastStoryCompletedAtMs = progress.lastProgressAtMs
    }
    if (lastStoryCompletedAtMs != undefined) {
      this.set(lastStoryCompletedAtMs / 1000)
    }
  },
})
