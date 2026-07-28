import { Upload as S3Upload } from "@aws-sdk/lib-storage"
import type { Logger } from "pino"
import {
  createSummaryForBuild,
  githubCheckRunName,
  gitlabStatusContext,
  ScreenshotTest,
  uploadTarballKey,
  WorkTask,
} from "shared"
import { uuidv7 } from "uuidv7"

import { getProjectByToken } from "../authenticate"
import { Database } from "../database"
import {
  APP_URL,
  ENABLE_VCS_STATUS,
  GITHUB_ENABLED,
  GITLAB_HOST,
  S3_BUCKET_NAME,
} from "../environment"
import { getInstallationForOrg, getOctokitForInstallation, type GitHubCheckData } from "../github"
import { getGitLabHostConfig, type GitLabCheckData, updateGitLabCommitStatus } from "../gitlab"
import { getQueryString } from "../http"
import { log } from "../log"
import { deleteObjectsByPrefixes, s3Client } from "../s3"
import { createScreenshotTest } from "../screenshotTests"
import type { DefaultRequest, DefaultResponse } from "../types"

const MAX_UPLOAD_BYTES = 1024 * 1024 * 100 // 100 MB
const MAX_BRANCH_LENGTH = 1024

export async function uploadStorybook(req: DefaultRequest, res: DefaultResponse): Promise<void> {
  const length = parseInt(req.header("content-length") ?? "")
  if (!length || isNaN(length)) {
    res.status(400).json({ error: "Missing Content-Length header" })
    return
  }
  if (length > MAX_UPLOAD_BYTES) {
    res.status(400).json({ error: `Upload too large: ${length} bytes (max ${MAX_UPLOAD_BYTES})` })
    return
  }

  const token = getQueryString("token", req)
  if (!token) {
    res.status(400).json({ error: "Missing token" })
    return
  }

  const commitSha = req.header("x-vizdiff-commit-sha") ?? ""
  if (!isValidGitCommitHash(commitSha)) {
    res.status(400).json({ error: `Invalid commit SHA: "${commitSha}"` })
    return
  }

  const branch = req.header("x-vizdiff-branch") ?? ""
  if (!branch || branch.length > MAX_BRANCH_LENGTH) {
    res.status(400).json({ error: `Invalid branch name: "${branch}"` })
    return
  }

  const baseCommitSha = req.header("x-vizdiff-base-commit-sha")
  const baseBranch = req.header("x-vizdiff-base-branch")
  if (baseCommitSha || baseBranch) {
    if (!baseCommitSha) {
      res.status(400).json({ error: "Missing base commit SHA" })
      return
    }
    if (!baseBranch) {
      res.status(400).json({ error: "Missing base branch name" })
      return
    }

    if (!isValidGitCommitHash(baseCommitSha)) {
      res.status(400).json({ error: `Invalid base commit SHA: "${baseCommitSha}"` })
      return
    }
    if (baseBranch.length > MAX_BRANCH_LENGTH) {
      res.status(400).json({ error: `Invalid base branch name: "${baseBranch}"` })
      return
    }
  }

  const pr = req.header("x-vizdiff-pr-number")
  const prNumber = pr ? parseInt(pr) : undefined
  if (prNumber != undefined && (isNaN(prNumber) || prNumber < 1)) {
    res.status(400).json({ error: `Invalid pull request number: "${pr}"` })
    return
  }

  const uploadId = uuidv7()
  const project = await getProjectByToken(token)
  if (!project) {
    res.status(401).json({ error: "Invalid token" })
    return
  }

  const logChild = log.child({
    userId: project.user.id,
    projectId: project.id,
    repo: project.repoUrl,
    vcsProvider: project.vcsProvider,
    uploadId,
    uploadLength: length,
    commitSha,
    branch,
    baseCommitSha,
    baseBranch,
    prNumber,
  })

  const db = await Database()

  // GitHub is disabled by default in self-hosted deployments. Reject GitHub uploads early.
  if (project.vcsProvider === "github" && !GITHUB_ENABLED) {
    logChild.warn(`GitHub upload rejected: GitHub support is disabled (set GITHUB_ENABLED=true)`)
    res.status(400).json({ error: "GitHub support is disabled in this deployment" })
    return
  }

  const Bucket = S3_BUCKET_NAME
  const Key = uploadTarballKey(project.id, uploadId)
  logChild.debug(`Uploading ${length} bytes to ${Bucket}/${Key}`)

  // Proxy the .tar.gz upload to S3 (reusing the shared lazy S3 client)
  const upload = new S3Upload({
    client: s3Client(),
    params: {
      Bucket,
      Key,
      Body: req,
      ContentType: "application/gzip",
      ContentLength: length,
    },
  })

  try {
    const result = await upload.done()
    void result // Ignore the result
  } catch (error) {
    logChild.error(error, `Failed to upload ${Key} to S3`)
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to upload to S3: ${msg}`)
  }

  logChild.info(`Uploaded ${length} bytes to ${Bucket}/${Key} for ${project.repoUrl}#${commitSha}`)

  // Extract the owner and repo from the repository URL
  const [owner, repo] = project.repoUrl.split("/").slice(-2)
  if (!owner || !repo) {
    throw new Error(`Invalid repository URL: ${project.repoUrl}`)
  }

  // Create a row in `screenshot_tests` for this upload
  const screenshotTest = await createScreenshotTest({
    project,
    commitSha,
    branch,
    uploadId,
    baseCommitSha,
    baseBranch,
    prNumber,
  })

  // Everything after row creation must either complete through the WorkTask enqueue or clean up
  // after itself: a failure here (e.g. GitHub check_run creation) would otherwise leave a
  // forever-pending screenshot_tests row and a leaked S3 tarball with no task to process them.
  try {
    // Create VCS status update based on provider
    let vcsStatusId: number | null = null
    let githubCheckData: GitHubCheckData | undefined
    let gitlabCheckData: GitLabCheckData | undefined

    if (project.vcsProvider === "github") {
      // Get the installation ID for this project
      const installation = await getInstallationForOrg(project.user.id, owner)
      if (!installation) {
        throw new Error(`GitHub App installation not found for ${owner}`)
      }

      // Create a GitHub check_run for this upload
      vcsStatusId = await createGitHubCheckRun({
        logChild,
        installationId: installation.installationId,
        owner,
        repo,
        commitSha,
        screenshotTest,
      })

      if (vcsStatusId) {
        githubCheckData = {
          owner,
          repo,
          checkRunId: vcsStatusId,
          installationId: installation.installationId,
        }
      }
    } else {
      // Create GitLab commit status for this upload using the configured per-host service token.
      const gitlabHost = project.gitlabHost ?? GITLAB_HOST
      const hostConfig = getGitLabHostConfig(gitlabHost)

      if (hostConfig && ENABLE_VCS_STATUS) {
        try {
          await updateGitLabCommitStatus(project.repoId, commitSha, "pending", {
            // Include the project key so multiple projects on one repo (monorepo) report
            // independent statuses on the same commit.
            name: gitlabStatusContext(project.key),
            targetUrl: `${APP_URL}/build?id=${screenshotTest.id}`,
            description: "Queued storybook upload for rendering",
            host: gitlabHost,
          })
          // GitLab doesn't return an ID for commit statuses, use 1 as a flag
          vcsStatusId = 1
          // Store only non-sensitive data; the worker resolves the service token by host at processing time
          gitlabCheckData = {
            projectId: project.repoId,
            commitSha,
            gitlabHost,
          }
          logChild.info(`Created GitLab commit status for ${project.repoUrl}#${commitSha}`)
        } catch (error) {
          logChild.error(error, `Failed to create GitLab commit status`)
          // Don't fail the upload if we can't create the commit status
        }
      } else if (!ENABLE_VCS_STATUS) {
        logChild.info(`Skipping GitLab commit status creation (ENABLE_VCS_STATUS not set)`)
      } else {
        logChild.warn(
          `No GitLab service token configured for host ${gitlabHost}, skipping commit status`,
        )
      }
    }

    // Update the screenshot test with the VCS status ID
    if (vcsStatusId != null) {
      screenshotTest.vcsStatusId = vcsStatusId
    }
    const screenshotTestTable = db.getRepository(ScreenshotTest)
    await screenshotTestTable.save(screenshotTest)

    // Add a task to the queue to process this screenshot test
    const task = new WorkTask()
    task.screenshotTest = screenshotTest
    task.taskType = "ingest_storybook"
    task.data = {
      projectId: project.id,
      uploadId,
      githubCheckData,
      gitlabCheckData,
    }
    task.createdAt = new Date()
    task.updatedAt = task.createdAt

    const tasks = db.getRepository(WorkTask)
    await tasks.save(task)
    // The worker is woken by the `task_queue` insert trigger (pg_notify), so no explicit NOTIFY here.
  } catch (error) {
    logChild.error(
      error,
      `Upload failed after creating screenshot test ${screenshotTest.id}; cleaning up`,
    )

    // Best-effort cleanup: remove the never-to-be-processed row (no WorkTask or test_results exist
    // yet) and the orphaned tarball, then surface the original error.
    try {
      await db.getRepository(ScreenshotTest).delete({ id: screenshotTest.id })
    } catch (cleanupError) {
      logChild.warn(cleanupError, `Failed to delete orphaned screenshot test ${screenshotTest.id}`)
    }
    try {
      // The full object key is used as the prefix, so only this upload's tarball is removed.
      await deleteObjectsByPrefixes([Key])
    } catch (cleanupError) {
      logChild.warn(cleanupError, `Failed to delete orphaned upload ${Bucket}/${Key}`)
    }

    throw error
  }

  res.json({ success: true, uploadId, testId: screenshotTest.id })
}

interface GitHubCheckRunData {
  logChild: Logger
  installationId: number
  owner: string
  repo: string
  commitSha: string
  screenshotTest: ScreenshotTest
}

// Create a GitHub check_run for a new upload
async function createGitHubCheckRun({
  logChild,
  installationId,
  owner,
  repo,
  commitSha,
  screenshotTest,
}: GitHubCheckRunData): Promise<number | null> {
  if (!ENABLE_VCS_STATUS) {
    logChild.info(`Skipping GitHub check_run creation (ENABLE_VCS_STATUS not set)`)
    return null
  }

  const screenshotTestId = screenshotTest.id
  const octokit = await getOctokitForInstallation(installationId)
  logChild.info({ screenshotTestId }, `Creating new GitHub check_run`)
  const checkRunResponse = await octokit.rest.checks.create({
    owner,
    repo,
    head_sha: commitSha,
    // Include the project key so multiple projects on one repo (monorepo) report independent
    // check runs on the same commit.
    name: githubCheckRunName(screenshotTest.project.key),
    status: "queued",
    details_url: `${APP_URL}/build?id=${screenshotTestId}`,
    output: {
      title: "Queued storybook upload for rendering",
      summary: createSummaryForBuild(screenshotTest),
    },
  })
  const githubCheckRunId = checkRunResponse.data.id
  logChild.info({ screenshotTestId, githubCheckRunId }, `Created new GitHub check_run`)
  return githubCheckRunId
}

function isValidGitCommitHash(hash: string): boolean {
  const regex = /^[0-9a-f]{40}$/i
  return regex.test(hash)
}
