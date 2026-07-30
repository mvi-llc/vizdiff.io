import type { TestResultErrorKind, TestResultStatus } from "../../../shared/src/entity/types"

// The frontend can only import *types* from shared (its runtime code never gets bundled — see the
// type-only imports idiom in this file and lib/apiTypes.ts), so mirror shared's INFRA_ERROR_KINDS /
// isInfraErrorKind here. Keep in sync with shared/src/entity/types.ts.
const INFRA_ERROR_KINDS: readonly TestResultErrorKind[] = [
  "browser-timeout",
  "browser-gone",
  "screenshot-failed",
  "storage",
]

/** True if the given error kind is infrastructure-caused (dead browser session, storage, ...). */
export function isInfraErrorKind(kind: string | null | undefined): boolean {
  return kind != undefined && (INFRA_ERROR_KINDS as readonly string[]).includes(kind)
}

export function changeStatusMessage(
  changeStatus: TestResultStatus,
  diffRatio: number,
  errorKind?: string,
): string {
  switch (changeStatus) {
    case "new":
      return "New"
    case "unchanged":
      return "Unchanged"
    case "changed":
      return `Changed (${(diffRatio * 100).toFixed(2)}%)`
    case "failed":
      // Infra-class failures (dead browser session, storage) mean the harness failed, not the
      // story (issue #454) — label them distinctly so reviewers don't read them as regressions.
      return isInfraErrorKind(errorKind) ? "Infra error" : "Failed"
    default:
      return String(changeStatus)
  }
}

export function changeStatusColor(changeStatus: TestResultStatus): string {
  switch (changeStatus) {
    case "unchanged":
      return "success.main"
    case "new":
    case "changed":
      return "warning.main"
    case "failed":
    default:
      return "error.main"
  }
}
