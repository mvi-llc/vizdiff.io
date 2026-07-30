import { DatabasePool } from "./database"
import { WORKER_ID } from "./identity"

/**
 * A task-queue row this worker has successfully claimed (locked). `id` is the queue row id —
 * the handle for releaseLock/deleteTask — and `data` is the row's parsed jsonb payload.
 */
export type ClaimedTask = {
  id: number
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

/** Validates the shape of a claimed task-queue row (jsonb `data` is parsed by node-postgres). */
function isClaimedTaskRow(row: unknown): row is ClaimedTask {
  return (
    row != null &&
    typeof row === "object" &&
    "id" in row &&
    "task_type" in row &&
    "screenshot_test_id" in row &&
    "data" in row &&
    "attempts" in row &&
    typeof row.id === "number" &&
    typeof row.task_type === "string" &&
    typeof row.screenshot_test_id === "number" &&
    typeof row.data === "object" &&
    row.data != null &&
    typeof row.attempts === "number"
  )
}

/**
 * Atomically claims the OLDEST eligible task in the queue (issue #456, cross-worker sharding
 * groundwork): selection and lock acquisition are one statement, so two workers polling
 * concurrently can never claim the same row.
 *
 *  - Oldest-first (`ORDER BY id ASC`): dependencies (e.g. a baseline build) are naturally
 *    processed before the dependents enqueued after them, and no task starves behind a stream
 *    of newer arrivals.
 *  - `FOR UPDATE SKIP LOCKED`: a row another transaction is mid-claim on is skipped instead of
 *    waited on, so concurrent workers contend without blocking each other.
 *  - Eligibility: unlocked rows, plus rows whose lock has expired (LOCK_TIMEOUT_MINUTES —
 *    crashed-worker recovery), minus `excludeIds` (tasks the caller is temporarily deferring or
 *    backing off, so the next-best task is claimed instead of re-selecting an ineligible one).
 *
 * The claim records the stable WORKER_ID (hostname, not pid — issue #451) so a restarted worker
 * can recognize its own orphaned work, and bumps `attempts` so the startup reclaim can bound
 * how many times a crashing build is requeued.
 *
 * Returns the claimed task, or undefined when no eligible task exists.
 */
export async function claimNextTask(
  excludeIds: readonly number[] = [],
): Promise<ClaimedTask | undefined> {
  const client = await DatabasePool()
  try {
    const res = await client.query(
      `UPDATE task_queue
       SET locked_at = NOW(), locked_by = $1, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM task_queue
         WHERE (locked_at IS NULL
            OR locked_at < NOW() - INTERVAL '${LOCK_TIMEOUT_MINUTES} minutes')
           AND NOT (id = ANY($2::int[]))
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING id, task_type, screenshot_test_id, data, attempts`,
      [WORKER_ID, [...excludeIds]],
    )
    if (res.rowCount === 0) {
      return undefined
    }
    const row = res.rows[0] as unknown
    if (!isClaimedTaskRow(row)) {
      throw new Error(`Claimed task has invalid row: ${JSON.stringify(row)}`)
    }
    return row
  } finally {
    client.release()
  }
}
