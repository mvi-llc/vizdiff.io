import createPgSubscriber from "pg-listen"
import { ScreenshotTest } from "shared"

import { closeDatabasePool, Database, DatabasePool } from "./database"
import {
  POSTGRES_USER,
  POSTGRES_HOST,
  POSTGRES_DATABASE,
  POSTGRES_PASS,
  POSTGRES_PORT,
  IS_TEST,
  RETENTION_REAPER_ENABLED,
  RETENTION_SWEEP_INTERVAL_MS,
  WORKER_MAX_TASK_ATTEMPTS,
  WORKER_STUCK_PENDING_MINUTES,
  WORKER_STUCK_RUNNING_MINUTES,
} from "./environment"
import type { GitHubCheckData } from "./github"
import type { GitLabCheckData } from "./gitlab"
import { markTaskFinished, markTaskStarted, startHealthServer } from "./health"
import { WORKER_ID } from "./identity"
import { ingestStorybook, isBaselineBuildPending } from "./ingest"
import { log } from "./log"
import { runRetentionSweep } from "./retention"
import {
  latestTaskQueueId,
  fetchTask,
  NonRetryableTaskError,
  DependencyNotReadyError,
} from "./tasks"
import { BuildTimeoutError } from "./timeout"
import { parseBuildCheckData, postBuildFailedStatus, type BuildCheckData } from "./vcsStatus"

type IngestStorybookPayload = {
  projectId: string
  uploadId: string
  githubCheckData?: GitHubCheckData
  gitlabCheckData?: GitLabCheckData
}

const TASKS_CHANNEL = "task_queue"
const CONN_STRING = `postgres://${POSTGRES_USER}:${POSTGRES_PASS}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}`
const POLL_INTERVAL_MS = 1000 * 10
const RETRY_INTERVAL_MS = 1000 * 15

const MAX_RETRY_COUNT = 5 // Maximum number of retries before giving up
const MAX_BACKOFF_MS = 1000 * 60 * 30 // 30 minutes max backoff
// Consider a build stuck if its last activity (COALESCE(last_progress_at, updated_at)) is older
// than this while "running". Minutes-scale relative to BUILD_TIMEOUT_MS (issue #451), not hours.
const STUCK_RUNNING_THRESHOLD_MINUTES = WORKER_STUCK_RUNNING_MINUTES
// Consider a build stuck if it's been pending for more than this amount of time
const STUCK_PENDING_THRESHOLD_MINUTES = WORKER_STUCK_PENDING_MINUTES
// Minimum interval between stuck-build sweeps. maybeSweepStuckBuilds() is invoked both from the
// idle poll tick and from a dedicated 1-minute timer (so sweeps still happen while a long build
// is in flight); this throttle bounds the actual sweep rate.
const STUCK_BUILD_SWEEP_INTERVAL_MS = 1000 * 60 * 5 // 5 minutes
// How often the dedicated stuck-build sweep timer fires. Each tick goes through the
// STUCK_BUILD_SWEEP_INTERVAL_MS throttle above, so the timer's job is only to guarantee sweeps
// keep happening when the worker is busy (the idle tick never fires mid-build).
const STUCK_BUILD_TIMER_INTERVAL_MS = 60_000

// How long to defer a render task each time its dependent (baseline) build is
// still pending/in-progress, before re-checking. This is the length of the
// exclusion window: the deferred task stays excluded from selection until
// `nextRetryTime = deferStart + DEFER_INTERVAL_MS`.
const DEFER_INTERVAL_MS = 1000 * 5 // 5 seconds
// How long to wait before re-polling after a deferral. This MUST be strictly
// less than DEFER_INTERVAL_MS so that when the worker re-polls, the deferred
// task is still inside its exclusion window (now < nextRetryTime) and therefore
// still excluded from selection. That guarantees the older dependency (lower id)
// is the only eligible candidate at the re-poll and gets picked next — without
// this gap, the re-poll fires exactly at nextRetryTime, the deferred (newer,
// higher-id) task is no longer excluded, and descending-id selection re-picks it
// instead of the dependency.
const DEFER_REPOLL_MS = 1000 * 2 // 2 seconds
// Maximum number of times a task may be deferred for an unfinished dependency
// before we give up waiting and process it anyway. This bounds the wait and
// guarantees forward progress (avoids livelock) if the dependent never finishes.
// 60 defers * 5s ≈ 5 minutes of waiting.
const MAX_DEFER_COUNT = 60

// Postgres notification listener
const subscriber = createPgSubscriber({ connectionString: CONN_STRING })
// Current task being processed, if any
let currentTaskId: number | undefined
// Set once a shutdown signal (SIGTERM/SIGINT) has been received; stops the worker from
// accepting any new tasks while the graceful shutdown runs.
let shuttingDown = false
// Timestamp of the last retention sweep, to throttle the reaper to RETENTION_SWEEP_INTERVAL_MS.
let lastRetentionSweepMs = 0
// Guards against overlapping retention sweeps if one runs longer than the poll interval.
let retentionSweepInFlight = false
// Timestamp of the last stuck-build sweep, to throttle it to STUCK_BUILD_SWEEP_INTERVAL_MS.
let lastStuckBuildSweepMs = 0
// Guards against overlapping stuck-build sweeps if one runs longer than the poll interval.
let stuckBuildSweepInFlight = false
// Map of task IDs to their failure count and next retry time
const failedTasksMap = new Map<number, { retryCount: number; nextRetryTime: number }>()
// Map of task IDs that are deferred waiting on a dependent (baseline) build,
// to their defer count and the time at which they may be retried.
const deferredTasksMap = new Map<number, { deferCount: number; nextRetryTime: number }>()

// Clear failed task ID after it's been retried the maximum number of times or after successful processing
function clearFailedTaskId(taskId: number): void {
  failedTasksMap.delete(taskId)
}

// Clear a task's deferral state once it has been processed (or given up on).
function clearDeferredTaskId(taskId: number): void {
  deferredTasksMap.delete(taskId)
}

// Set of task ids that are currently deferred and not yet due for retry. These
// are excluded from task selection so the worker can pick the dependent build
// (typically an older, lower-id task) instead of re-selecting the deferred one.
//
// The exclusion window is [deferStart, nextRetryTime). Because the post-deferral
// re-poll is scheduled at DEFER_REPOLL_MS < DEFER_INTERVAL_MS (i.e. strictly
// before nextRetryTime), the deferred task is guaranteed to still be excluded at
// that re-poll, leaving the older dependency as the only eligible candidate.
function activeDeferredTaskIds(now: number): Set<number> {
  const ids = new Set<number>()
  for (const [taskId, info] of deferredTasksMap) {
    if (now < info.nextRetryTime) {
      ids.add(taskId)
    }
  }
  return ids
}

// Set of task ids that are inside a failure-backoff window and not yet due for
// retry. These are excluded from task selection the same way deferred tasks are,
// so a single failing task (with up to 30 minutes of backoff) cannot starve the
// queue: latestTaskQueueId() returns the next eligible task instead of
// repeatedly returning the backing-off one and stalling.
function activeBackoffTaskIds(now: number): Set<number> {
  const ids = new Set<number>()
  for (const [taskId, info] of failedTasksMap) {
    if (now < info.nextRetryTime) {
      ids.add(taskId)
    }
  }
  return ids
}

async function main() {
  startHealthServer()

  // Reclaim builds this worker owned before a crash/restart (issue #451) BEFORE subscribing for
  // new tasks, so an orphaned "running" build is requeued or failed instead of sitting in
  // "running" until the sweeper's threshold. Best-effort: a transient DB error must not
  // crash-loop the worker at boot.
  try {
    await reclaimOrphanedBuilds(WORKER_ID)
  } catch (err) {
    log.error(err, "Error reclaiming orphaned builds at startup")
  }

  // Sweep for stuck builds on a dedicated timer as well as on idle poll ticks: the idle tick
  // never fires while a build is in flight, so without this a wedged sibling worker's build
  // would only be swept when this worker went idle. The call is throttled internally.
  startStuckBuildSweepTimer()

  subscriber.notifications.on(TASKS_CHANNEL, (payload) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- pg-listen payload is untyped
    log.info(`Received notification in '${TASKS_CHANNEL}':`, payload)
    if (typeof payload !== "string" && typeof payload !== "number") {
      log.error(`Invalid payload type: ${typeof payload}`)
      return
    }

    const taskQueueId = typeof payload === "string" ? parseInt(payload, 10) : payload
    if (isNaN(taskQueueId)) {
      log.error(`Invalid task queue ID: ${payload}`)
      return
    }

    if (shuttingDown) {
      log.info(`Ignoring task ${taskQueueId} notification: worker is shutting down`)
      return
    }

    startTask(taskQueueId).catch((err: unknown) => log.error(err, "Error processing task"))
  })

  subscriber.events.on("error", (error) => {
    if (error instanceof AggregateError) {
      for (const err of error.errors) {
        log.error(err, "Database subscriber aggregate error")
      }
    } else {
      log.error(error, "Database subscriber error")
    }
    log.fatal("Exiting worker due to database subscriber error(s)")
    process.exit(1)
  })

  process.on("exit", shutdown)
  // Graceful shutdown on `docker stop` / Ctrl-C: stop accepting new tasks, release the
  // current task's lock so another worker can pick it up immediately (instead of waiting out
  // LOCK_TIMEOUT_MINUTES), close the subscriber and pool, then exit.
  process.on("SIGTERM", handleShutdownSignal)
  process.on("SIGINT", handleShutdownSignal)

  await subscriber.connect()
  await subscriber.listenTo(TASKS_CHANNEL)

  log.info("Starting worker poll")
  pollForNewTasks()
}

/**
 * Run the screenshot retention reaper (#79) at most once per RETENTION_SWEEP_INTERVAL_MS, only when
 * enabled. Fire-and-forget: it runs in the background off the idle worker tick and never blocks task
 * processing. A guard prevents overlapping sweeps.
 */
export function maybeRunRetentionSweep(): void {
  if (!RETENTION_REAPER_ENABLED || retentionSweepInFlight) {
    return
  }
  const now = Date.now()
  if (now - lastRetentionSweepMs < RETENTION_SWEEP_INTERVAL_MS) {
    return
  }
  lastRetentionSweepMs = now
  retentionSweepInFlight = true
  runRetentionSweep()
    .catch((err: unknown) => log.error(err, "Error during retention sweep"))
    .finally(() => {
      retentionSweepInFlight = false
    })
}

/**
 * Run the stuck-build sweep at most once per STUCK_BUILD_SWEEP_INTERVAL_MS. Fire-and-forget,
 * mirroring maybeRunRetentionSweep(): it runs in the background off the idle worker tick and
 * never blocks task processing. A guard prevents overlapping sweeps.
 */
export function maybeSweepStuckBuilds(): void {
  if (stuckBuildSweepInFlight) {
    return
  }
  const now = Date.now()
  if (now - lastStuckBuildSweepMs < STUCK_BUILD_SWEEP_INTERVAL_MS) {
    return
  }
  lastStuckBuildSweepMs = now
  stuckBuildSweepInFlight = true
  sweepStuckBuilds()
    .then((stuckBuildsCount) => {
      if (stuckBuildsCount > 0) {
        log.info(`Found and updated ${stuckBuildsCount} stuck builds`)
      } else {
        log.trace(`No stuck builds found`)
      }
    })
    .catch((err: unknown) => log.error(err, "Error sweeping for stuck builds"))
    .finally(() => {
      stuckBuildSweepInFlight = false
    })
}

/**
 * Register the dedicated stuck-build sweep timer (issue #451). Unlike the idle poll tick, this
 * fires even while a (possibly wedged) build is in flight, so stuck builds are swept on a
 * minutes-scale cadence regardless of worker business. Each tick goes through
 * maybeSweepStuckBuilds()'s throttle, which bounds the actual sweep rate. Unref'd so it never
 * keeps a shutting-down process alive.
 */
export function startStuckBuildSweepTimer(): NodeJS.Timeout {
  return setInterval(() => maybeSweepStuckBuilds(), STUCK_BUILD_TIMER_INTERVAL_MS).unref()
}

export function pollForNewTasks(): void {
  // Stop polling once a shutdown signal has been received
  if (shuttingDown) {
    log.debug("Worker is shutting down, stopping poll")
    return
  }

  // Early return if we're already processing a task
  if (currentTaskId != undefined) {
    log.debug("Worker is busy, skipping poll")
    setTimeout(() => pollForNewTasks(), POLL_INTERVAL_MS)
    return
  }

  // Exclude tasks that are deferred waiting on a dependent build, and tasks that
  // are inside a failure-backoff window, so the worker picks the next eligible
  // task instead of looping on (or stalling behind) an ineligible one.
  const now = Date.now()
  const excludeIds = activeDeferredTaskIds(now)
  for (const taskId of activeBackoffTaskIds(now)) {
    excludeIds.add(taskId)
  }

  latestTaskQueueId(excludeIds)
    .then((taskQueueId) => {
      if (taskQueueId == undefined) {
        log.trace(`No new tasks, checking for stuck builds...`)
        // Idle: opportunistically run the retention reaper and the stuck-build sweep (both
        // throttled and fire-and-forget).
        maybeRunRetentionSweep()
        maybeSweepStuckBuilds()
        setTimeout(() => pollForNewTasks(), POLL_INTERVAL_MS)
        return
      }

      log.info(`Found new task: ${taskQueueId}`)
      startTask(taskQueueId)
        .then(() => {
          // Task was processed successfully, immediately check for more tasks
          // Use process.nextTick to avoid growing the stack too much with synchronous tasks
          log.debug("Task completed successfully, immediately checking for more tasks")
          clearDeferredTaskId(taskQueueId)
          process.nextTick(() => pollForNewTasks())
        })
        .catch((err: unknown) => {
          // Recompute the current time: `now` above was captured before the task
          // ran, so using it here would make the defer/backoff windows for a
          // long-running task already (partially) elapsed.
          const failedAt = Date.now()

          // A dependent (baseline) build is still pending/in-progress. Defer this
          // task for a short delay and let the worker pick the dependent first.
          // This is NOT a failure, so don't touch the backoff/retry budget.
          if (err instanceof DependencyNotReadyError) {
            const deferInfo = deferredTasksMap.get(taskQueueId) ?? {
              deferCount: 0,
              nextRetryTime: 0,
            }
            deferInfo.deferCount += 1
            deferInfo.nextRetryTime = failedAt + DEFER_INTERVAL_MS
            deferredTasksMap.set(taskQueueId, deferInfo)
            log.info(
              `Deferring task ${taskQueueId} (${deferInfo.deferCount}/${MAX_DEFER_COUNT}) for ${DEFER_INTERVAL_MS / 1000}s: ${err.message}`,
            )
            // Re-poll sooner than the exclusion window expires (DEFER_REPOLL_MS <
            // DEFER_INTERVAL_MS) so the deferred task is still excluded at the
            // re-poll and the worker picks the older dependency instead of
            // re-selecting this (newer, higher-id) task.
            setTimeout(() => pollForNewTasks(), DEFER_REPOLL_MS)
            return
          }

          log.error(err, `Error processing task ${taskQueueId}`)

          // Non-retryable failures have already been deleted from the queue in
          // processTask(); don't record a backoff entry, just poll for more work.
          if (err instanceof NonRetryableTaskError) {
            clearFailedTaskId(taskQueueId)
            setTimeout(() => pollForNewTasks(), POLL_INTERVAL_MS)
            return
          }

          // Update retry count and calculate next retry with exponential backoff
          const taskFailureInfo = failedTasksMap.get(taskQueueId) ?? {
            retryCount: 0,
            nextRetryTime: 0,
          }
          taskFailureInfo.retryCount += 1

          if (taskFailureInfo.retryCount > MAX_RETRY_COUNT) {
            log.error(
              `Task ${taskQueueId} has failed ${taskFailureInfo.retryCount} times, giving up`,
            )
            clearFailedTaskId(taskQueueId)
            clearDeferredTaskId(taskQueueId)
            // Actually give up: delete the task row (otherwise it would be
            // re-selected and the whole retry cycle would restart forever) and
            // mark its build failed so it doesn't sit in pending/running until
            // the stuck-build sweep finds it.
            giveUpOnTask(taskQueueId)
              .catch((giveUpErr: unknown) => {
                log.error(giveUpErr, `Failed to delete given-up task ${taskQueueId}`)
              })
              .finally(() => setTimeout(() => pollForNewTasks(), POLL_INTERVAL_MS))
            return
          }

          // Calculate exponential backoff: 2^retryCount * base interval, with a maximum cap
          const backoffMs = Math.min(
            Math.pow(2, taskFailureInfo.retryCount) * RETRY_INTERVAL_MS,
            MAX_BACKOFF_MS,
          )
          taskFailureInfo.nextRetryTime = failedAt + backoffMs
          failedTasksMap.set(taskQueueId, taskFailureInfo)

          const backoffSec = Math.round(backoffMs / 1000)
          log.info(
            `Task ${taskQueueId} failed ${taskFailureInfo.retryCount} times, will retry in ${backoffSec}s`,
          )

          // For failures, use the normal poll interval
          setTimeout(() => pollForNewTasks(), POLL_INTERVAL_MS)
        })
    })
    .catch((err: unknown) => {
      log.error(err, "Error fetching latest task queue ID")
      setTimeout(() => pollForNewTasks(), POLL_INTERVAL_MS)
    })
}

export async function startTask(taskQueueId: number): Promise<void> {
  // Don't accept new tasks while shutting down
  if (shuttingDown) {
    log.info(`Cannot start task ${taskQueueId}: worker is shutting down`)
    return
  }
  // Check if we're already processing a task
  if (currentTaskId != undefined) {
    log.info(`Cannot start task ${taskQueueId}: worker is already processing task ${currentTaskId}`)
    return
  }
  currentTaskId = taskQueueId
  markTaskStarted(taskQueueId)

  try {
    const task = await fetchTask(taskQueueId)
    if (!task) {
      log.warn(`Not starting task ${taskQueueId}: fetchTask() failed`)
      // The row may be gone entirely (completed/deleted by another worker), in
      // which case any in-memory retry/deferral state for it must not linger.
      clearFailedTaskId(taskQueueId)
      clearDeferredTaskId(taskQueueId)
      currentTaskId = undefined
      return
    }

    log.debug(`Fetched task ${taskQueueId} [${task.task_type}]`)
    await processTask(task.task_type, task.screenshot_test_id, task.data)

    // If we got here, the task was successful, so clear it from the failed tasks map
    clearFailedTaskId(taskQueueId)
  } catch (error) {
    if (error instanceof DependencyNotReadyError) {
      // Expected control-flow signal (waiting on a dependent build), not a failure.
      log.debug(`Task ${taskQueueId} deferred: ${error.message}`)
    } else {
      log.error(error, `Error processing task ${taskQueueId}`)
    }
    throw error
  } finally {
    markTaskFinished()
    currentTaskId = undefined
  }
}

export async function processTask(
  taskType: string,
  screenshotTestId: number,
  data: Record<string, unknown>,
): Promise<void> {
  log.info(`Processing task: [${taskType}] ${JSON.stringify(data)}`)
  try {
    switch (taskType) {
      case "ingest_storybook": {
        const { projectId, uploadId, githubCheckData, gitlabCheckData } =
          data as Partial<IngestStorybookPayload>
        if (!projectId || !uploadId) {
          throw new Error(
            `Missing required ingest_storybook fields: projectId=${projectId}, uploadId=${uploadId}`,
          )
        }

        // If this render task depends on a baseline build that is still
        // pending/in-progress, defer it so the dependent is processed first and
        // this task gets a populated baseline (issue #125). Give up waiting after
        // MAX_DEFER_COUNT deferrals so a never-finishing dependency can't block
        // this task forever (livelock guard); in that case we process anyway.
        const deferCount =
          currentTaskId != undefined ? (deferredTasksMap.get(currentTaskId)?.deferCount ?? 0) : 0
        if (deferCount < MAX_DEFER_COUNT && (await isBaselineBuildPending(screenshotTestId))) {
          throw new DependencyNotReadyError(
            `Baseline build for screenshot test ${screenshotTestId} is still pending; deferring`,
          )
        }
        if (deferCount >= MAX_DEFER_COUNT) {
          log.warn(
            `Baseline for screenshot test ${screenshotTestId} did not finish after ${deferCount} deferrals; processing anyway`,
          )
        }

        await ingestStorybook(
          projectId,
          screenshotTestId,
          uploadId,
          githubCheckData,
          gitlabCheckData,
          // Pass the queue row id so the fatal fast-fail path (issue #451) can delete it before
          // process.exit — a wedged build is non-retryable.
          currentTaskId,
        )

        // Task completed successfully, delete it from the queue
        if (currentTaskId) {
          await deleteTask(currentTaskId)
        }
        break
      }
      default:
        throw new Error(`Unknown task type: ${taskType}`)
    }
  } catch (error) {
    if (currentTaskId) {
      if (error instanceof NonRetryableTaskError) {
        // Permanent failure (e.g. the upload tarball is gone). Retrying cannot
        // succeed, so delete the task from the queue instead of releasing the
        // lock for backoff retries. The task handler has already marked the
        // ScreenshotTest as failed.
        log.warn(error, `Task ${currentTaskId} failed permanently, deleting from queue`)
        await deleteTask(currentTaskId)
      } else if (error instanceof BuildTimeoutError) {
        // A timed-out build is almost always stuck or pathologically large. Retrying would just
        // burn another full timeout window, so treat it as terminal: delete the task instead of
        // releasing the lock. The ScreenshotTest has already been marked "failed" by ingest.
        log.warn(`Task ${currentTaskId} exceeded the build timeout; deleting (non-retryable)`)
        await deleteTask(currentTaskId)
      } else {
        // On a transient error, release the lock so it can be retried with backoff
        await releaseLock(currentTaskId)
      }
    }
    throw error
  }
}

export function shutdown(): void {
  subscriber.close().catch((err: unknown) => {
    log.error(err, "Error during shutdown")
    process.exit(1)
  })
}

/**
 * Graceful shutdown on SIGTERM/SIGINT (e.g. `docker stop`): stop accepting new tasks, release
 * the current task's lock so another worker can pick it up immediately instead of waiting out
 * LOCK_TIMEOUT_MINUTES, close the notification subscriber and connection pool, then exit. A
 * second signal during shutdown exits immediately.
 */
export function handleShutdownSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    log.warn(`Received ${signal} while already shutting down, exiting immediately`)
    process.exit(1)
  }
  shuttingDown = true
  log.info(`Received ${signal}, shutting down gracefully...`)

  void (async () => {
    // Stop receiving NOTIFY-triggered tasks
    try {
      await subscriber.close()
    } catch (err) {
      log.error(err, "Error closing database subscriber during shutdown")
    }

    // Release the in-flight task's lock (the process is exiting, so the task will not
    // finish here; releasing lets another worker pick it up right away)
    if (currentTaskId != undefined) {
      try {
        await releaseLock(currentTaskId)
      } catch (err) {
        log.error(err, `Error releasing lock for task ${currentTaskId} during shutdown`)
      }
    }

    // Reset any build this worker owns that is still "running" back to "pending" (issue #451):
    // the released task can then be picked up by another worker without tripping the startup
    // reclaim or the stuck-build sweeper.
    try {
      const client = await DatabasePool()
      try {
        await client.query(
          `UPDATE screenshot_tests
           SET status = 'pending', worker_id = NULL, updated_at = NOW()
           WHERE status = 'running' AND worker_id = $1`,
          [WORKER_ID],
        )
      } finally {
        client.release()
      }
    } catch (err) {
      log.error(err, "Error resetting in-flight build to pending during shutdown")
    }

    try {
      await closeDatabasePool()
    } catch (err) {
      log.error(err, "Error closing database pool during shutdown")
    }

    log.info("Graceful shutdown complete")
    process.exit(0)
  })()
}

export async function releaseLock(taskQueueId: number): Promise<void> {
  const client = await DatabasePool()
  try {
    log.debug(`Releasing lock for task ${taskQueueId}`)
    await client.query("UPDATE task_queue SET locked_at = NULL, locked_by = NULL WHERE id = $1", [
      taskQueueId,
    ])
  } finally {
    client.release()
  }
}

/**
 * Delete a task from the queue after it's been successfully processed.
 */
export async function deleteTask(taskQueueId: number): Promise<void> {
  const client = await DatabasePool()
  try {
    log.debug(`Deleting task ${taskQueueId} from queue`)
    await client.query("DELETE FROM task_queue WHERE id = $1", [taskQueueId])
  } finally {
    client.release()
  }
}

/**
 * Permanently give up on a task that has exhausted its retry budget: delete the task row from
 * the queue (so it is never re-selected and the retry cycle cannot restart) and mark its build
 * failed if it is still pending/running — mirroring what sweepStuckBuilds() sets for builds
 * that will never produce results.
 */
export async function giveUpOnTask(taskQueueId: number): Promise<void> {
  const client = await DatabasePool()
  try {
    log.warn(`Giving up on task ${taskQueueId}: deleting it from the queue`)
    const res = await client.query(
      "DELETE FROM task_queue WHERE id = $1 RETURNING screenshot_test_id",
      [taskQueueId],
    )
    if (res.rowCount === 0) {
      return
    }
    const { screenshot_test_id: screenshotTestId } = res.rows[0] as {
      screenshot_test_id: number | null
    }
    if (screenshotTestId != undefined) {
      await client.query(
        `UPDATE screenshot_tests
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'running')`,
        [screenshotTestId],
      )
    }
  } finally {
    client.release()
  }
}

/**
 * Reclaim builds orphaned by a previous incarnation of this worker (issue #451): builds still
 * marked "running" with our worker id after a crash/OOM-kill/fatal exit. Called once at startup,
 * before the worker subscribes for new tasks.
 *
 * For each orphaned build: if its queue row survives and its attempt budget
 * (WORKER_MAX_TASK_ATTEMPTS) is not exhausted, requeue it (unlock the task, flip the build back
 * to pending) so it is retried; otherwise fail the build, drop any queue row, and best-effort
 * post the failed VCS status so CI is unblocked immediately.
 */
export async function reclaimOrphanedBuilds(workerId: string): Promise<void> {
  const client = await DatabasePool()
  try {
    const res = await client.query(
      `SELECT id FROM screenshot_tests WHERE status = 'running' AND worker_id = $1`,
      [workerId],
    )
    if ((res.rowCount ?? 0) === 0) {
      log.debug(`No orphaned running builds owned by ${workerId}`)
      return
    }
    log.warn(`Found ${res.rowCount} orphaned running build(s) owned by ${workerId}; reclaiming`)

    for (const row of res.rows as Array<{ id: number }>) {
      const buildId = row.id
      const taskRes = await client.query(
        `SELECT id, attempts FROM task_queue
         WHERE screenshot_test_id = $1 AND task_type = 'ingest_storybook'
         ORDER BY id DESC
         LIMIT 1`,
        [buildId],
      )
      const task =
        (taskRes.rowCount ?? 0) > 0
          ? (taskRes.rows[0] as { id: number; attempts: number })
          : undefined

      if (task && task.attempts < WORKER_MAX_TASK_ATTEMPTS) {
        // Requeue: unlock the task and flip the build back to pending so any worker (including
        // this one) can pick it up again.
        log.warn(
          `Requeueing orphaned build ${buildId} (task ${task.id}, attempt ${task.attempts}/${WORKER_MAX_TASK_ATTEMPTS})`,
        )
        await client.query(
          `UPDATE task_queue SET locked_at = NULL, locked_by = NULL WHERE id = $1`,
          [task.id],
        )
        await client.query(
          `UPDATE screenshot_tests
           SET status = 'pending', worker_id = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [buildId],
        )
      } else {
        // The queue row is gone (the task cannot run again) or the attempt budget is exhausted
        // (the build reliably kills a worker): fail the build instead of crash-looping on it.
        log.warn(
          task
            ? `Failing orphaned build ${buildId}: attempt budget exhausted (${task.attempts}/${WORKER_MAX_TASK_ATTEMPTS})`
            : `Failing orphaned build ${buildId}: its task queue row is gone`,
        )
        const upd = await client.query(
          `UPDATE screenshot_tests
           SET status = 'failed', worker_id = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'running'
           RETURNING id`,
          [buildId],
        )
        let checkData: BuildCheckData | undefined
        if (task) {
          const del = await client.query(`DELETE FROM task_queue WHERE id = $1 RETURNING data`, [
            task.id,
          ])
          checkData = parseBuildCheckData((del.rows[0] as { data?: unknown } | undefined)?.data)
        }
        if ((upd.rowCount ?? 0) > 0) {
          await postFailedStatusForBuildId(
            buildId,
            "Build was orphaned by a worker restart and could not be retried",
            checkData,
          )
        }
      }
    }
  } finally {
    client.release()
  }
}

/**
 * Load a build through TypeORM (for its eager project + user relations) and best-effort post the
 * failed VCS status for it. Used by the startup reclaim and the stuck-build sweeper, where only
 * the build id (and possibly salvaged task check data) is at hand. Never throws.
 */
async function postFailedStatusForBuildId(
  buildId: number,
  reason: string,
  checkData?: BuildCheckData,
): Promise<void> {
  try {
    const db = await Database()
    const screenshotTest = await db.getRepository(ScreenshotTest).findOneBy({ id: buildId })
    if (!screenshotTest) {
      log.warn(`Cannot post failed VCS status for build ${buildId}: build not found`)
      return
    }
    await postBuildFailedStatus(screenshotTest, reason, checkData)
  } catch (err) {
    log.error(err, `Error posting failed VCS status for build ${buildId}`)
  }
}

/**
 * Checks for screenshot tests that have been in "running" or "pending" status for too long
 * and marks them as "failed".
 *
 * A "running" build is stuck once its last activity — COALESCE(last_progress_at, updated_at);
 * last_progress_at is reserved for the render progress watchdog (#452) and not yet written — is
 * older than WORKER_STUCK_RUNNING_MINUTES. A "pending" build is stuck once updated_at is older
 * than WORKER_STUCK_PENDING_MINUTES.
 *
 * Each stuck build is failed via a conditional UPDATE (`WHERE id = $1 AND status = <observed>`),
 * so when several workers sweep concurrently only the one whose UPDATE returns the row deletes
 * the build's queue rows and posts the failed VCS status — at most one status post per build.
 *
 * @returns Promise with the number of stuck builds that were updated
 */
export async function sweepStuckBuilds(): Promise<number> {
  log.trace(
    `Sweeping for stuck builds (running threshold: ${STUCK_RUNNING_THRESHOLD_MINUTES} minutes, pending threshold: ${STUCK_PENDING_THRESHOLD_MINUTES} minutes)`,
  )

  try {
    const db = await Database()
    const screenshotTestRepo = db.getRepository(ScreenshotTest)

    // Find stuck "running" builds by last activity (progress heartbeat when available, else the
    // last status write).
    const stuckRunningBuilds = await screenshotTestRepo
      .createQueryBuilder("test")
      .where("test.status = :status", { status: "running" })
      .andWhere(
        "COALESCE(test.last_progress_at, test.updated_at) < NOW() - (:minutes * INTERVAL '1 minute')",
        { minutes: STUCK_RUNNING_THRESHOLD_MINUTES },
      )
      .getMany()

    // Find stuck "pending" builds
    const stuckPendingBuilds = await screenshotTestRepo
      .createQueryBuilder("test")
      .where("test.status = :status", { status: "pending" })
      .andWhere("test.updated_at < NOW() - (:minutes * INTERVAL '1 minute')", {
        minutes: STUCK_PENDING_THRESHOLD_MINUTES,
      })
      .getMany()

    // Combine both lists
    const stuckBuilds = [...stuckRunningBuilds, ...stuckPendingBuilds]

    if (stuckBuilds.length === 0) {
      return 0
    }

    log.info(
      `Found ${stuckBuilds.length} stuck builds to update (${stuckRunningBuilds.length} running, ${stuckPendingBuilds.length} pending)`,
    )

    let sweptCount = 0
    const client = await DatabasePool()
    try {
      for (const build of stuckBuilds) {
        // Conditional flip: only proceed if the build is still in the status we observed. A
        // concurrent sweeper (or the build finishing) loses/wins this race atomically, so the
        // queue-row cleanup and VCS status post below happen exactly once.
        const upd = await client.query(
          `UPDATE screenshot_tests SET status = 'failed', updated_at = NOW()
           WHERE id = $1 AND status = $2
           RETURNING id`,
          [build.id, build.status],
        )
        if ((upd.rowCount ?? 0) === 0) {
          continue
        }
        sweptCount++

        const lastActivityAt = build.lastProgressAt ?? build.updatedAt
        const stuckDurationHours = (Date.now() - lastActivityAt.getTime()) / (1000 * 60 * 60)
        log.warn(
          `Marking stuck build ${build.id} as failed (stuck in "${build.status}" for ${stuckDurationHours.toFixed(1)} hours)`,
        )

        // Drop any queue rows so the dead build cannot be re-selected, salvaging the stored VCS
        // check data for the status post.
        const del = await client.query(
          `DELETE FROM task_queue WHERE screenshot_test_id = $1 RETURNING data`,
          [build.id],
        )
        let checkData: BuildCheckData | undefined
        for (const delRow of del.rows as Array<{ data?: unknown }>) {
          checkData ??= parseBuildCheckData(delRow.data)
        }

        // Re-load through find (not the query builder) so eager relations (project, user) are
        // populated for check-data reconstruction.
        await postFailedStatusForBuildId(
          build.id,
          `Build was stuck in "${build.status}" and marked failed by the stuck-build sweeper`,
          checkData,
        )
      }
    } finally {
      client.release()
    }

    return sweptCount
  } catch (error) {
    log.error(error, "Error while sweeping for stuck builds")
    throw error
  }
}

// Entry point. Skipped under test so importing this module for unit tests does
// not start the background poll loop / database subscriber.
if (!IS_TEST) {
  main().catch((err: unknown) => {
    // Exit non-zero instead of lingering: the health server would otherwise keep a zombie
    // process alive with nothing polling. Exiting lets the orchestrator restart the worker.
    log.fatal(err, "Uncaught error in main(), exiting")
    process.exit(1)
  })
}
