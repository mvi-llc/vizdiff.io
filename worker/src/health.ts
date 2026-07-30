import http from "node:http"

import { DatabasePool } from "./database"
import { VIZDIFF_VERSION, WORKER_HEALTH_PORT } from "./environment"
// Stable per-instance identity so multiple workers each keep their own `worker_status` row.
import { WORKER_ID } from "./identity"
import { log } from "./log"

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

export function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.statusCode = 404
      res.end()
      return
    }

    const payload = {
      status: "ok",
      version: VIZDIFF_VERSION,
      lastHeartbeatAt,
      lastTaskStartedAt,
      lastTaskFinishedAt,
      activeTaskId,
    }

    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(payload))
  })

  // Listen on all interfaces: container healthchecks reach this endpoint from outside localhost.
  server.listen(WORKER_HEALTH_PORT, () => {
    log.info(
      `Worker health endpoint listening on port ${WORKER_HEALTH_PORT} (all interfaces) at /health`,
    )
  })

  // Record our version + liveness immediately, then refresh on every heartbeat.
  void reportWorkerStatus()
  setInterval(() => {
    lastHeartbeatAt = Date.now()
    void reportWorkerStatus()
  }, 10_000).unref()
}
