/**
 * Supported Version Control System providers
 */
export type VCSProvider = "github" | "gitlab"

/**
 * Status values for screenshot test results
 */
export type TestResultStatus = "new" | "unchanged" | "changed" | "failed"

/**
 * Classification of why a test result has `changeStatus = "failed"` (issue #454).
 *
 * Story-class kinds mean the story itself is broken (it threw, or never became ready); infra-class
 * kinds mean the harness failed (dead browser session, storage errors, etc.) and the story may be
 * perfectly fine. Kept as a separate nullable column rather than a fifth `TestResultStatus` value
 * so existing status handling (throwing switches, sorting, counts) is unaffected.
 */
export type TestResultErrorKind =
  | "story-error"
  | "render-timeout"
  | "story-load-timeout"
  | "ready-signal-timeout"
  | "browser-timeout"
  | "browser-gone"
  | "screenshot-failed"
  | "storage"
  | "unknown"

/**
 * Error kinds caused by infrastructure (browser session, storage) rather than the story itself.
 * Failures with these kinds should read as "failed to render" rather than "story is broken".
 */
export const INFRA_ERROR_KINDS: readonly TestResultErrorKind[] = [
  "browser-timeout",
  "browser-gone",
  "screenshot-failed",
  "storage",
]

/**
 * True if the given error kind is infrastructure-caused (see {@link INFRA_ERROR_KINDS}).
 * Accepts any string (plus null/undefined) so API/frontend callers can pass values straight
 * from responses without narrowing.
 */
export function isInfraErrorKind(kind: string | null | undefined): boolean {
  return kind != undefined && (INFRA_ERROR_KINDS as readonly string[]).includes(kind)
}

/**
 * Per-story troubleshooting context captured by the worker when a test result fails
 * (issue #475), stored in the `test_results.diagnostics` jsonb column. Only set when
 * `changeStatus` is "failed"; NULL otherwise (and for rows written before the feature).
 *
 * All fields are hard-capped by the worker at write time (console tail length/entry size,
 * pending-request count/URL length, and an overall serialized size budget), so readers can
 * treat the payload as small.
 */
export interface TestResultDiagnostics {
  /** Tail of the browser console (including page JS exceptions) leading up to the failure. */
  consoleTail: { level: string; text: string; stampMs: number }[]
  /** Network requests still in flight when the story failed, longest-pending first. */
  pendingRequests: { url: string; pendingMs: number }[]
  /** S3 object key of the best-effort failure-time screenshot, when one was captured. */
  failureScreenshotKey?: string
}

/**
 * Status values for screenshot tests (builds)
 */
export type ScreenshotTestStatus =
  | "pending"
  | "running"
  | "no_changes"
  | "unapproved"
  | "approved"
  | "denied"
  | "failed"
