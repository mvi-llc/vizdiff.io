import { DatabasePool } from "./database"
import { log } from "./log"

/**
 * Minimum interval between `last_progress_at` persists. touch() is called once per completed
 * story, which at high concurrency can be several times per second; the heartbeat only needs to
 * be fresh on the stuck-build sweeper's minutes-scale, so writes are throttled to at most one
 * per this window.
 */
const PROGRESS_PERSIST_THROTTLE_MS = 2000

/**
 * In-process progress state for the build currently being rendered (issue #452). The progress
 * watchdog in timeout.ts polls `lastProgressAtMs` to detect a stalled build, and the throttled
 * `last_progress_at` heartbeat lets the cross-worker stuck-build sweeper (worker.ts) distinguish
 * a large-but-healthy build from a wedged one.
 */
export interface BuildProgress {
  buildId: number
  startedAtMs: number
  expectedStories: number
  completedStories: number
  lastProgressAtMs: number
  /**
   * Record forward progress: refresh `lastProgressAtMs` and fire the throttled
   * `last_progress_at` heartbeat. Does not increment `completedStories`; story completions go
   * through {@link BuildProgress.completeStory}. A no-op on a stale handle (after
   * endBuildProgress()).
   */
  touch(): void
  /** Count one completed story (success or recorded failure) and touch(). */
  completeStory(): void
}

class BuildProgressImpl implements BuildProgress {
  buildId: number
  startedAtMs: number
  expectedStories: number
  completedStories = 0
  lastProgressAtMs: number
  #lastPersistMs = 0

  constructor(buildId: number, expectedStories: number) {
    this.buildId = buildId
    this.expectedStories = expectedStories
    this.startedAtMs = Date.now()
    this.lastProgressAtMs = this.startedAtMs
  }

  touch(): void {
    if (currentProgress !== this) {
      // Stale handle: endBuildProgress() has run (or another build began). A late story
      // completion racing the teardown must not write a heartbeat for a finished build.
      return
    }
    const now = Date.now()
    this.lastProgressAtMs = now
    if (now - this.#lastPersistMs < PROGRESS_PERSIST_THROTTLE_MS) {
      return
    }
    this.#lastPersistMs = now
    // Fire-and-forget: the heartbeat must never block or fail the render path.
    void persistProgress(this.buildId)
  }

  completeStory(): void {
    if (currentProgress !== this) {
      return
    }
    this.completedStories += 1
    this.touch()
  }
}

/**
 * Best-effort `last_progress_at` heartbeat. Deliberately does NOT bump `updated_at`: the sweeper
 * reads COALESCE(last_progress_at, updated_at), and keeping the columns separate preserves
 * `updated_at` as a pure status-transition timestamp.
 */
async function persistProgress(buildId: number): Promise<void> {
  try {
    const client = await DatabasePool()
    try {
      await client.query(`UPDATE screenshot_tests SET last_progress_at = NOW() WHERE id = $1`, [
        buildId,
      ])
    } finally {
      client.release()
    }
  } catch (err) {
    // Debug, not error: a missed heartbeat is harmless (the sweeper threshold is minutes-scale
    // and also falls back to updated_at), and a flaky database must not spam the logs mid-build.
    log.debug(err, `Failed to persist last_progress_at heartbeat for build ${buildId}`)
  }
}

// Module-level singleton: the worker renders at most one build at a time.
let currentProgress: BuildProgressImpl | undefined

/** Begin tracking progress for a build. Replaces any previous (stale) tracker. */
export function beginBuildProgress(buildId: number, expectedStories: number): BuildProgress {
  currentProgress = new BuildProgressImpl(buildId, expectedStories)
  return currentProgress
}

/** Stop tracking the current build. Late touch()/completeStory() calls become no-ops. */
export function endBuildProgress(): void {
  currentProgress = undefined
}

/** The progress tracker for the in-flight build, if any. */
export function getCurrentBuildProgress(): BuildProgress | undefined {
  return currentProgress
}
