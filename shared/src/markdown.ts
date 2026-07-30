import type { ScreenshotTest } from "./entity/ScreenshotTest"
import type { TestResult } from "./entity/TestResult"
import { isInfraErrorKind } from "./entity/types"
import type { VCSProvider } from "./entity/types"

const EMPTY_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/5/59/Empty.png"
const FAILED_IMAGE_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Red_X.svg/480px-Red_X.svg.png"

/**
 * The deployment's public base URL, used for links posted into VCS comments/checks. Read lazily
 * from the environment (set via APP_URL on the api/worker) since this self-hosted instance — not
 * vizdiff.io — is the canonical server.
 */
function appUrl(): string {
  return process.env.APP_URL ?? "https://vizdiff.io"
}

/**
 * Get the commit URL for a given provider
 * GitHub: /commit/{sha}
 * GitLab: /-/commit/{sha}
 */
function getCommitUrl(repoUrl: string, sha: string, provider: VCSProvider): string {
  const separator = provider === "gitlab" ? "/-/commit/" : "/commit/"
  return `${repoUrl}${separator}${sha}`
}

/**
 * Get the branch/tree URL for a given provider
 * GitHub: /tree/{branch}
 * GitLab: /-/tree/{branch}
 */
function getBranchUrl(repoUrl: string, branch: string, provider: VCSProvider): string {
  const separator = provider === "gitlab" ? "/-/tree/" : "/tree/"
  return `${repoUrl}${separator}${branch}`
}

// Generates a Markdown summary for a screenshot test build (works for both GitHub and GitLab)
export function createSummaryForBuild(build: ScreenshotTest): string {
  const repoUrl = build.project.repoUrl
  const provider = build.project.vcsProvider

  if (build.baseCommitSha) {
    let summary =
      `Rendering storybook components for [build #${build.buildNumber}](${appUrl()}/build?id=${build.id}), ` +
      `comparing commit [${build.commitSha}](${getCommitUrl(repoUrl, build.commitSha, provider)}) ` +
      `(branch [${build.branch}](${getBranchUrl(repoUrl, build.branch, provider)})) against ` +
      `[${build.baseCommitSha}](${getCommitUrl(repoUrl, build.baseCommitSha, provider)})`
    summary += build.baseBranch
      ? ` (branch [${build.baseBranch}](${getBranchUrl(repoUrl, build.baseBranch, provider)}))`
      : "."
    return summary
  }

  return (
    `Rendering storybook components for [build #${build.buildNumber}](${appUrl()}/build?id=${build.id}), ` +
    `commit [${build.commitSha}](${getCommitUrl(repoUrl, build.commitSha, provider)}) ` +
    `(branch [${build.branch}](${getBranchUrl(repoUrl, build.branch, provider)})).`
  )
}

export function createSummaryForFailedBuild(build: ScreenshotTest, error: unknown): string {
  const errString = error instanceof Error ? error.message : String(error)
  const repoUrl = build.project.repoUrl
  const provider = build.project.vcsProvider

  if (build.baseCommitSha) {
    let summary =
      `⚠️ Failed to render storybook components for [build #${build.buildNumber}](${appUrl()}/build?id=${build.id}), ` +
      `comparing commit [${build.commitSha}](${getCommitUrl(repoUrl, build.commitSha, provider)}) ` +
      `(branch [${build.branch}](${getBranchUrl(repoUrl, build.branch, provider)})) against ` +
      `[${build.baseCommitSha}](${getCommitUrl(repoUrl, build.baseCommitSha, provider)})`
    summary += build.baseBranch
      ? ` (branch [${build.baseBranch}](${getBranchUrl(repoUrl, build.baseBranch, provider)}))`
      : "."
    summary += `\n\n---\nUpload ID: ${build.uploadId}\nReason: ${errString}`
    return summary
  }

  let summary =
    `⚠️ Failed to render storybook components for [build #${build.buildNumber}](${appUrl()}/build?id=${build.id}), ` +
    `commit [${build.commitSha}](${getCommitUrl(repoUrl, build.commitSha, provider)}) ` +
    `(branch [${build.branch}](${getBranchUrl(repoUrl, build.branch, provider)})).`
  summary += `\n\n---\nUpload ID: ${build.uploadId}\nReason: ${errString}`
  return summary
}

/**
 * Maps a stored image reference (an S3 object key, since the bucket is private) to a URL the VCS
 * UI can load — typically a presigned URL. Defaults to identity for callers/tests that pass
 * ready-to-use URLs. See api/src/s3.ts / worker/src/s3.ts for the presigning implementation.
 */
type ImageUrlResolver = (stored: string | null) => string | null

export function createMarkdownForBuildResult(
  build: ScreenshotTest,
  testResults: TestResult[],
  resolveImageUrl: ImageUrlResolver = (v) => v,
): { title: string; summary: string; text: string } {
  const testCount = testResults.length
  const changeCount = getChangeCount(testResults)
  const failedResults = testResults.filter((r) => r.changeStatus === "failed")
  const failedCount = failedResults.length
  // Infra-class failures (dead browser session, storage) mean the harness failed, not the story
  // (issue #454) — call them out so reviewers don't read them as product regressions.
  const infraFailedCount = failedResults.filter((r) => isInfraErrorKind(r.errorKind)).length

  // Create the title that shows up inline in the Pull Request list of status checks
  const title =
    changeCount > 0
      ? `${changeCount} change${changeCount === 1 ? "" : "s"} to review.`
      : "No visual changes detected."

  // Create the summary that appears at the top of this status check's details page
  const statusText = getStatusHeader(build)
  let summary =
    `|**${testCount}**|**${changeCount}**|**${statusText}**|\n` +
    `|-|-|:-:|\n` +
    `|Tests|Changes|Status|\n\n` +
    `Review [build #${build.buildNumber}](${appUrl()}/build?id=${build.id}) for a detailed comparison.`
  if (failedCount > 0) {
    const infraSuffix =
      infraFailedCount > 0
        ? ` (${infraFailedCount} due to infrastructure error${infraFailedCount === 1 ? "" : "s"})`
        : ""
    summary += `\n\n---\n ⚠️ ${failedCount} test${failedCount === 1 ? "" : "s"} failed to render${infraSuffix}.`
  }

  // Sort test results to show failed/changed/new/unchanged in that order
  const sortedTestResults = getSortedTestResults(testResults)

  // Create the detailed text that appears below the summary on this status check's details page
  let text = "### Visual Tests\n"
  for (const testResult of sortedTestResults) {
    const baselineUrl = resolveImageUrl(testResult.baselineImageUrl)
    const newUrl = resolveImageUrl(testResult.newImageUrl)
    text += `> **${testResult.name}**\n`
    // Before image
    if (testResult.changeStatus === "new") {
      text += `> <img src="${EMPTY_IMAGE_URL}" alt="No baseline image" width="250" /> &nbsp;&nbsp;&nbsp; `
    } else {
      text +=
        `> <a href="${baselineUrl}">` +
        `<img src="${baselineUrl}" alt="${testResult.screenshotTest.baseCommitSha ?? "Baseline"}" width="250" />` +
        `</a> &nbsp;&nbsp;&nbsp; `
    }
    // After image
    if (testResult.changeStatus === "failed") {
      text += `<img src="${FAILED_IMAGE_URL}" alt="Failed" width="250" />\n`
    } else {
      text +=
        `<a href="${newUrl}">` +
        `<img src="${newUrl}" alt="${testResult.screenshotTest.commitSha}" width="250" />` +
        `</a>\n`
    }
    // Status line
    text += `> ${getChangeStatusText(testResult)}\n\n`
  }

  return { title, summary, text }
}

export function createMarkdownForBuildApproval(
  build: ScreenshotTest,
  testResults: TestResult[],
  username: string,
  resolveImageUrl: ImageUrlResolver = (v) => v,
): { title: string; summary: string; text?: string } {
  if (build.status !== "approved" && build.status !== "denied") {
    throw new Error(
      `Cannot generate approval markdown for test ${build.id} status: ${build.status}`,
    )
  }

  const approved = build.status === "approved"
  const changeCount = getChangeCount(testResults)
  const title = `${changeCount} change${changeCount === 1 ? "" : "s"} ${build.status} by ${username}.`

  let { summary, text } = createMarkdownForBuildResult(build, testResults, resolveImageUrl)
  summary += `\n\n---\n ${approved ? "✅ Approved" : "❌ Rejected"} by ${username}`

  return { title, summary, text }
}

function getChangeCount(testResults: TestResult[]): number {
  return testResults.filter((r) => r.changeStatus === "new" || r.changeStatus === "changed").length
}

function getStatusHeader(build: ScreenshotTest): string {
  switch (build.status) {
    case "pending":
      return "⏳ $${\\color{goldenrod}Pending}$$"
    case "running":
      return "🚧 $${\\color{goldenrod}Running}$$"
    case "no_changes":
      return "🟢 $${\\color{green}Unchanged}$$"
    case "unapproved":
      return "🟡 $${\\color{goldenrod}Pending}$$"
    case "approved":
      return "✅ $${\\color{green}Approved}$$"
    case "denied":
      return "❌ $${\\color{red}Denied}$$"
    case "failed":
      return "❗ $${\\color{red}Failed}$$"
    default:
      throw new Error(`Unknown build status: ${build.status}`)
  }
}

function getChangeStatusText(testResult: TestResult): string {
  switch (testResult.changeStatus) {
    case "new":
      return `🟡 New`
    case "unchanged":
      return `🟢 Unchanged`
    case "changed": {
      const changePct = testResult.diffRatio ? ` (${(testResult.diffRatio * 100).toFixed(2)}%)` : ""
      return `🟡 Changed${changePct}`
    }
    case "failed":
      // Distinguish infra-caused failures (issue #454) from genuine story failures.
      return isInfraErrorKind(testResult.errorKind) ? `🔴 Failed (infrastructure)` : `🔴 Failed`
    default:
      throw new Error(`Unknown change status: ${testResult.changeStatus}`)
  }
}

function getSortedTestResults(testResults: TestResult[]): TestResult[] {
  // Create a copy of test results sorted by change status
  // (failed, changed, new, unchanged), then by name
  const statusOrder: { [key: string]: number } = {
    failed: 0,
    changed: 1,
    new: 2,
    unchanged: 3,
  }
  const sortedTestResults = testResults.slice().sort((a, b) => {
    const statusA = statusOrder[a.changeStatus] ?? 99
    const statusB = statusOrder[b.changeStatus] ?? 99

    if (statusA !== statusB) {
      return statusA - statusB // Sort by status priority
    }
    // If statuses are the same, sort by name alphabetically
    return a.name.localeCompare(b.name)
  })

  return sortedTestResults
}
