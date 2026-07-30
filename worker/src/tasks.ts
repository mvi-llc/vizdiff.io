import { DatabasePool } from "./database"
import { WORKER_ID } from "./identity"
import { log } from "./log"

type Task = {
  task_type: string
  screenshot_test_id: number
  data: Record<string, unknown>
  attempts: number
}

const LOCK_TIMEOUT_MINUTES = 60

/**
 * Error that signals the task should NOT be retried. When the worker catches one
 * of these it deletes the task from the queue instead of releasing the lock for
 * an exponential-backoff retry. Use this for permanent failures where retrying
 * cannot possibly succeed (e.g. the uploaded build tarball no longer exists in
 * S3). The associated `ScreenshotTest` should already be marked failed by the
 * task handler before throwing.
 */
export class NonRetryableTaskError extends Error {
  override readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "NonRetryableTaskError"
    this.cause = cause
  }
}

/**
 * Error thrown when a render task depends on another (baseline) build that is
 * still pending/in-progress. The worker handles this by releasing the lock and
 * deferring the task for a short delay so the dependent build is processed
 * first, instead of treating it as a failure and burning retry/backoff budget.
 */
export class DependencyNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DependencyNotReadyError"
  }
}

/**
 * S3 / AWS SDK error names (the `name` field on a thrown error) that represent
 * permanent, non-retryable failures when fetching the uploaded build tarball.
 * These are restricted to genuine "the object is not retrievable" cases: the
 * object key is missing, or it has been archived to Glacier and a GET will keep
 * failing until it is restored. Anything else — including auth/permission
 * failures (403 / AccessDenied / Forbidden), missing buckets, 5xx, timeouts, and
 * network errors — is treated as transient so a deployment/IRSA/bucket-policy/KMS
 * blip recovers on retry instead of permanently deleting the queue row for an
 * object that actually exists.
 */
const PERMANENT_S3_ERROR_NAMES = new Set<string>([
  "NoSuchKey", // The object key does not exist (tarball was deleted / expired)
  "NotFound", // 404 variant surfaced for HEAD/GET in some SDK paths
  "InvalidObjectState", // Object archived to Glacier; GET fails until restored
])

/**
 * Returns true if the given error represents a permanent S3 fetch failure that
 * should not be retried. Matches on the AWS SDK v3 error `name` as well as a
 * 404 `$metadata.httpStatusCode` as a fallback. Only genuine object-missing /
 * archived errors are permanent; transient failures (including 403 auth blips)
 * stay retryable.
 */
export function isPermanentS3FetchError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) {
    return false
  }

  const name = (error as { name?: unknown }).name
  if (typeof name === "string" && PERMANENT_S3_ERROR_NAMES.has(name)) {
    return true
  }

  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
  const statusCode = metadata?.httpStatusCode
  if (typeof statusCode === "number" && statusCode === 404) {
    return true
  }

  return false
}

/**
 * Returns the id of the newest unlocked task in the queue, optionally excluding
 * a set of task ids that the caller is temporarily deferring (e.g. tasks waiting
 * on a dependent build). Excluding them here lets the worker pick the next-best
 * task (typically the older dependency) instead of repeatedly re-selecting the
 * deferred one.
 */
export async function latestTaskQueueId(
  excludeIds: ReadonlySet<number> = new Set(),
): Promise<number | undefined> {
  const client = await DatabasePool()
  try {
    const params: unknown[] = []
    let excludeClause = ""
    if (excludeIds.size > 0) {
      const placeholders = [...excludeIds].map((_, i) => `$${i + 1}`).join(", ")
      excludeClause = `AND id NOT IN (${placeholders})`
      params.push(...excludeIds)
    }
    const res = await client.query(
      `SELECT id FROM task_queue
       WHERE (locked_at IS NULL
          OR locked_at < NOW() - INTERVAL '${LOCK_TIMEOUT_MINUTES} minutes')
         ${excludeClause}
       ORDER BY id DESC
       LIMIT 1`,
      params,
    )
    if (res.rowCount === 0) {
      return undefined
    }
    return (res.rows[0] as { id: number }).id
  } finally {
    client.release()
  }
}

export async function fetchTask(taskQueueId: number): Promise<Task | undefined> {
  const client = await DatabasePool()
  try {
    // First try to acquire the lock atomically, respecting the lock timeout. The claim records
    // the stable WORKER_ID (hostname, not pid — issue #451) so a restarted worker can recognize
    // its own orphaned work, and bumps `attempts` so the startup reclaim can bound how many
    // times a crashing build is requeued.
    const lockRes = await client.query(
      `UPDATE task_queue
       SET locked_at = NOW(), locked_by = $1, attempts = attempts + 1
       WHERE id = $2
         AND (locked_at IS NULL
           OR locked_at < NOW() - INTERVAL '${LOCK_TIMEOUT_MINUTES} minutes')
       RETURNING task_type, screenshot_test_id, data, attempts`,
      [WORKER_ID, taskQueueId],
    )

    // If no rows were updated, the task was already locked or doesn't exist
    if (lockRes.rowCount === 0) {
      const checkRes = await client.query(
        "SELECT locked_at, locked_by FROM task_queue WHERE id = $1",
        [taskQueueId],
      )
      if (checkRes.rowCount === 0) {
        // The task row is gone (e.g. deleted by another worker after finishing
        // it). This is not a failure of ours to retry; the caller clears any
        // in-memory retry/deferral state for the id.
        log.warn(`Task not found: ${taskQueueId} (likely completed by another worker)`)
        return undefined
      }
      const task = checkRes.rows[0] as { locked_by: string; locked_at: Date }
      const lockAge = Math.floor((Date.now() - task.locked_at.getTime()) / (1000 * 60))
      log.warn(
        `Task ${taskQueueId} is locked by ${task.locked_by} since ${task.locked_at} (${lockAge} minutes ago)`,
      )
      return undefined
    }

    // Validate the task entry has the expected fields and types
    const row = lockRes.rows[0] as unknown
    if (
      !row ||
      typeof row !== "object" ||
      !("task_type" in row) ||
      !("screenshot_test_id" in row) ||
      !("data" in row) ||
      !("attempts" in row) ||
      typeof row.task_type !== "string" ||
      typeof row.screenshot_test_id !== "number" ||
      typeof row.data !== "object" ||
      typeof row.attempts !== "number"
    ) {
      throw new Error(`Task ${taskQueueId} has invalid row: ${JSON.stringify(row)}`)
    }

    return row as Task
  } finally {
    client.release()
  }
}
