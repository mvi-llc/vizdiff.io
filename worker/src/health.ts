import http from "node:http"

import { DatabasePool } from "./database"
import { VIZDIFF_VERSION, WORKER_HEALTH_PORT, WORKER_PROGRESS_TIMEOUT_MS } from "./environment"
// Stable per-instance identity so multiple workers each keep their own `worker_status` row.
import { WORKER_ID } from "./identity"
import { log } from "./log"
import { metricsRegistry } from "./metrics"
import { getCurrentBuildProgress } from "./progress"

let lastHeartbeatAt = Date.now()
let lastTaskStartedAt: number | null = null
let lastTaskFinishedAt: number | null = null
let activeTaskId: number | null = null

/**
 * Upsert this worker's row in `worker_status` so the api can surface the running version + liveness
 * via GET /api/version. Best-effort: a brand-new database may not have the table until the api has
 * run migrations, so failures are logged and retried on the next heartbeat. `started_at` is only set
 * on first insert (ON CONFLICT leaves it untouched).
 */
async function reportWorkerStatus(): Promise<void> {
  let client
  try {
    client = await DatabasePool()
    await client.query(
      `INSERT INTO worker_status (id, version, last_heartbeat_at, started_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = now(), version = EXCLUDED.version`,
      [WORKER_ID, VIZDIFF_VERSION],
    )
  } catch (err) {
    log.warn(`Failed to report worker status: ${String(err)}`)
  } finally {
    client?.release()
  }
}

export function markTaskStarted(taskId: number): void {
  activeTaskId = taskId
  lastTaskStartedAt = Date.now()
}

export function markTaskFinished(): void {
  activeTaskId = null
  lastTaskFinishedAt = Date.now()
}

/**
 * Snapshot of the in-flight build for the /health payload, plus the degraded determination
 * (issue #457): a build is degraded when it is active but no story has made progress for longer
 * than the progress-watchdog window (WORKER_PROGRESS_TIMEOUT_MS; skipped when that is 0). This is
 * the externally visible twin of the #452 in-process watchdog — alerting sees the wedge as soon
 * as the watchdog would, without waiting for users to report stuck builds.
 */
function buildHealthStatus(): {
  status: "ok" | "degraded"
  degradedReason?: string
  progress: {
    activeBuildId: number
    expectedStories: number
    completedStories: number
    lastStoryCompletedAt: number
  } | null
} {
  const buildProgress = getCurrentBuildProgress()
  if (!buildProgress) {
    return { status: "ok", progress: null }
  }
  const progress = {
    activeBuildId: buildProgress.buildId,
    expectedStories: buildProgress.expectedStories,
    completedStories: buildProgress.completedStories,
    lastStoryCompletedAt: buildProgress.lastProgressAtMs,
  }
  const stalledForMs = Date.now() - buildProgress.lastProgressAtMs
  if (WORKER_PROGRESS_TIMEOUT_MS > 0 && stalledForMs > WORKER_PROGRESS_TIMEOUT_MS) {
    return {
      status: "degraded",
      degradedReason:
        `build ${buildProgress.buildId} has made no progress for ${stalledForMs}ms ` +
        `(threshold ${WORKER_PROGRESS_TIMEOUT_MS}ms; ` +
        `${buildProgress.completedStories}/${buildProgress.expectedStories} stories completed)`,
      progress,
    }
  }
  return { status: "ok", progress }
}

/**
 * The health/metrics HTTP handler, exported for tests. Routes:
 *
 *  - /health — readiness + rich status JSON. Always HTTP 200, even when degraded: Helm's
 *    liveness probe restarts the pod on non-200, and a pod restart is exactly the wrong response
 *    to a stalled build — the #452 progress watchdog handles the stall in-process with proper
 *    build-failure bookkeeping (status flip, queue cleanup, VCS notification). The degraded
 *    signal is carried in the JSON `status` field for alerting to scrape.
 *  - /health/live — bare 200 (event-loop-alive) for the liveness probe.
 *  - /metrics — Prometheus exposition (issue #457).
 */
export function healthRequestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === "/health/live") {
    res.setHeader("Content-Type", "text/plain")
    res.end("ok")
    return
  }

  if (req.url === "/metrics") {
    metricsRegistry
      .metrics()
      .then((body) => {
        res.setHeader("Content-Type", metricsRegistry.contentType)
        res.end(body)
      })
      .catch((err: unknown) => {
        log.warn(err, "Failed to collect metrics for /metrics scrape")
        res.statusCode = 500
        res.end("metrics collection failed")
      })
    return
  }

  if (req.url !== "/health") {
    res.statusCode = 404
    res.end()
    return
  }

  const { status, degradedReason, progress } = buildHealthStatus()
  const payload = {
    status,
    ...(degradedReason != undefined ? { degradedReason } : {}),
    version: VIZDIFF_VERSION,
    lastHeartbeatAt,
    lastTaskStartedAt,
    lastTaskFinishedAt,
    activeTaskId,
    progress,
  }

  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(payload))
}

export function startHealthServer(): void {
  const server = http.createServer(healthRequestHandler)

  // Listen on all interfaces: container healthchecks reach this endpoint from outside localhost.
  server.listen(WORKER_HEALTH_PORT, () => {
    log.info(
      `Worker health endpoint listening on port ${WORKER_HEALTH_PORT} (all interfaces) at ` +
        `/health, /health/live, and /metrics`,
    )
  })

  // Record our version + liveness immediately, then refresh on every heartbeat.
  void reportWorkerStatus()
  setInterval(() => {
    lastHeartbeatAt = Date.now()
    void reportWorkerStatus()
  }, 10_000).unref()
}
