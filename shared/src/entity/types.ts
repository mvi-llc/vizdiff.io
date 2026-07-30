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
