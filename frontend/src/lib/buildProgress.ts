import type { TestResultResponse } from "./apiTypes"

/**
 * Per-status breakdown of the results a running build has produced so far (issue #477).
 * `completed` counts every result row; the other buckets partition them by review meaning:
 * `ok` = unchanged, `changed` = needs review ("changed" and "new"), `failed` = story errored.
 */
export type ProgressBreakdown = { completed: number; ok: number; changed: number; failed: number }

export function computeProgress(results: TestResultResponse[]): ProgressBreakdown {
  let ok = 0
  let changed = 0
  let failed = 0
  for (const result of results) {
    switch (result.changeStatus) {
      case "unchanged":
        ok++
        break
      case "changed":
      case "new":
        changed++
        break
      case "failed":
        failed++
        break
    }
  }
  return { completed: results.length, ok, changed, failed }
}

/**
 * How long a running build may go without a progress heartbeat before the UI flags it as
 * possibly stalled. The worker heartbeats per completed story (throttled to ~2s), but a single
 * story can legitimately take up to its 60s render timeout — so the threshold sits comfortably
 * above that to avoid crying wolf on slow-but-healthy stories.
 */
export const STALLED_THRESHOLD_MS = 90_000

/** True when the server-computed progress age exceeds {@link STALLED_THRESHOLD_MS}. */
export function isStalled(lastProgressAgeMs: number | undefined): boolean {
  return lastProgressAgeMs != undefined && lastProgressAgeMs > STALLED_THRESHOLD_MS
}
