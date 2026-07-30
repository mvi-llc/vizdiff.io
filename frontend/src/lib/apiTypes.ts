export type TestResultStatus = "new" | "unchanged" | "changed" | "failed"

export type VCSProvider = "github" | "gitlab"

export type GithubUser = {
  login: string
  id: number
  name: string | null
  node_id: string
  avatar_url: string
  email: string | null
}

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
  ownedProjectCount: number
  createdStampSec: number
  updatedStampSec: number
  // GitHub fields (only populated when GITHUB_ENABLED)
  githubId: string | null
  githubUsername: string | null
  githubProfile: GithubUser | null
  githubInstallations: GitHubInstallationResponse[]
}

export type ProjectResponse = {
  id: number
  name: string
  vcsProvider: VCSProvider
  repoUrl: string
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
  buildNumber: number
  vcsProvider: VCSProvider
  repoUrl: string
  commitSha: string
  branch: string
  baseCommitSha?: string
  baseBranch?: string
  prNumber?: number
  mergeRequestId?: number
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
  createdStampSec: number
}

export type TestResponse = ScreenshotTestResponse & {
  parent?: ScreenshotTestResponse
  testResults: TestResultResponse[]
}
