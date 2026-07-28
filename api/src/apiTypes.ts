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
  createdStampSec: number
}

export type TestResponse = ScreenshotTestResponse & {
  parent?: ScreenshotTestResponse
  testResults: TestResultResponse[]
}
