import type { TestResultStatus, VCSProvider } from "shared"

import type { GithubUser } from "./schemas/GithubUser"

export type GitHubInstallationResponse = {
  id: number
  installationId: number
  accountId: string
  accountName: string
  accountType: string
  isCreator: boolean
  createdStampSec: number
}

export type UserResponse = {
  id: number
  email: string | null
  displayName: string | null
  authProvider: string | null
  // GitHub fields (only populated when GITHUB_ENABLED)
  githubId: string | null
  githubUsername: string | null
  githubProfile: GithubUser | null
  githubInstallations: GitHubInstallationResponse[]
  // Common fields
  ownedProjectCount: number
  createdStampSec: number
  updatedStampSec: number
}

export type ProjectResponse = {
  id: number
  name: string
  vcsProvider: VCSProvider
  repoUrl: string
  // Legacy alias for backward compatibility
  githubRepoUrl: string
  // Monorepo discriminator; empty string for the repo's default (or only) project
  key: string
  token: string
  ownerId: number
  createdStampSec: number
  lastBuildStampSec: number
  builds: number
  tests: number
}

export type ScreenshotTestResponse = {
  id: number
  projectId: number
  projectName: string
  vcsProvider: VCSProvider
  repoUrl: string
  // Legacy alias for backward compatibility
  githubRepoUrl: string
  buildNumber: number
  commitSha: string
  branch: string
  baseCommitSha?: string
  baseBranch?: string
  prNumber?: number
  uploadId: string
  status: "pending" | "running" | "no_changes" | "unapproved" | "approved" | "denied" | "failed"
  tag?: string
  initiatedStampSec: number
  buildDurationSec?: number
}

export type ScreenshotTestSummaryResponse = ScreenshotTestResponse & {
  components?: number
  stories?: number
  changes?: number
}

/** Paginated list of build summaries for a project. */
export type BuildsListResponse = {
  builds: ScreenshotTestSummaryResponse[]
  /** True if more builds exist beyond the returned page (use offset + limit to fetch them). */
  hasMore: boolean
}

export type TestResultResponse = {
  id: number
  name: string
  changeStatus: TestResultStatus
  screenshotUrl: string
  ancestorScreenshotUrl?: string
  diffMaskUrl?: string
  diffRatio?: number
  /** Why the result failed (issue #454); a `TestResultErrorKind` value. Only set for failed results. */
  errorKind?: string
  /** Human-readable error detail accompanying errorKind. Only set for failed results. */
  errorMessage?: string
  /** Failure troubleshooting context (issue #475). Only set for failed results. */
  diagnostics?: {
    console: { level: string; text: string; stampMs: number }[]
    pendingRequests: { url: string; pendingMs: number }[]
    failureScreenshotUrl?: string
  }
  createdStampSec: number
}

export type TestResponse = ScreenshotTestResponse & {
  parent?: ScreenshotTestResponse
  /**
   * Total number of stories this build is expected to produce results for (issue #476). Written
   * by the worker once the storybook's stories are enumerated; absent for builds that predate it
   * or have not reached enumeration yet.
   */
  expectedStoryCount?: number
  /**
   * Milliseconds since the worker last reported render progress for this build (issue #477).
   * Server-computed so client clock skew cannot distort the staleness math; falls back to the
   * build row's last update time when no progress heartbeat has been written yet. Only present
   * while the build status is "pending" or "running". Note a healthy build can legitimately go
   * quiet for tens of seconds (heartbeats are per completed story, and a single story may take
   * up to the story timeout).
   */
  lastProgressAgeMs?: number
  /**
   * Identity of the worker currently rendering this build (issue #477). Only present while the
   * build status is "pending" or "running".
   */
  workerId?: string
  testResults: TestResultResponse[]
}
