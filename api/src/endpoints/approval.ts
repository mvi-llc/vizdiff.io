import {
  createMarkdownForBuildApproval,
  githubCheckRunName,
  gitlabStatusContext,
  ScreenshotTest,
  TestResult,
} from "shared"

import { Database } from "../database"
import { APP_URL, ENABLE_VCS_STATUS, GITHUB_ENABLED, GITLAB_HOST } from "../environment"
import { getInstallationForOrg, getOctokitForInstallation } from "../github"
import { getGitLabHostConfig, updateGitLabCommitStatus } from "../gitlab"
import { getParamInt } from "../http"
import { log } from "../log"
import { buildImageUrlResolver } from "../s3"
import type { RequestHandler } from "../types"

export const approveOrDeny: RequestHandler = async (req, res) => {
  const { user } = res.locals
  const testId = getParamInt("id", req)
  const status = req.params.status

  if (!testId) {
    res.status(400).json({ error: "Missing id" })
    return
  }
  if (!status) {
    res.status(400).json({ error: "Missing status" })
    return
  }
  if (status !== "approved" && status !== "denied") {
    res.status(400).json({ error: "Invalid status" })
    return
  }

  const db = await Database()

  // Any authenticated user can approve/deny any project's tests.
  const testTable = db.getRepository(ScreenshotTest)
  const test = await testTable
    .createQueryBuilder("test")
    .innerJoinAndSelect("test.project", "project")
    .innerJoinAndSelect("project.user", "projectOwner")
    .where("test.id = :id", { id: testId })
    .getOne()

  if (!test) {
    log.error({ user, testId, status }, "Test not found")
    res.status(404).json({ error: "Test not found" })
    return
  }

  // Update the screenshot test status
  test.status = status
  await testTable.save(test)

  // Update VCS status if available (GitHub check run or GitLab commit status)
  // GitLab does not need vcsStatusId - we can post a final status by commit SHA alone.
  // This allows recovery when the initial pending status failed during upload (transient API errors).
  const shouldUpdateVcs =
    ENABLE_VCS_STATUS && (test.vcsStatusId != null || test.project.vcsProvider === "gitlab")
  if (shouldUpdateVcs) {
    try {
      // Count the number of visual changes that were approved or denied
      const testResultTable = db.getRepository(TestResult)
      const testResults = await testResultTable.find({
        where: { screenshotTest: { id: test.id } },
      })

      if (test.project.vcsProvider === "github" && GITHUB_ENABLED) {
        // Extract the GitHub owner and repo from the repository URL
        const [owner, repo] = test.project.repoUrl.split("/").slice(-2)
        if (!owner || !repo) {
          throw new Error(`Invalid GitHub repository URL: ${test.project.repoUrl}`)
        }

        // Get the installation ID for this project
        const installation = await getInstallationForOrg(user.id, owner)
        if (!installation) {
          throw new Error(`GitHub App installation not found for ${owner}`)
        }

        const username = user.displayName ?? user.githubUsername ?? "Unknown"

        const resolveImageUrl = await buildImageUrlResolver(testResults)
        const { title, summary, text } = createMarkdownForBuildApproval(
          test,
          testResults,
          username,
          resolveImageUrl,
        )

        // Create a new check run with the success or failure conclusion
        const conclusion = status === "approved" ? "success" : "failure"
        const octokit = await getOctokitForInstallation(installation.installationId)
        const result = await octokit.checks.create({
          owner,
          repo,
          head_sha: test.commitSha,
          external_id: String(test.id),
          name: githubCheckRunName(test.project.key),
          status: "completed",
          conclusion,
          details_url: `${APP_URL}/build?id=${test.id}`,
          output: { title, summary, text },
        })
        log.info(
          {
            userId: user.id,
            testId: test.id,
            checkRunId: result.data.id,
            status,
            createStatus: result.status,
            conclusion,
          },
          `Created GitHub check run ${result.data.id} for ${test.toString()} with conclusion: ${conclusion}`,
        )
      } else if (test.project.vcsProvider === "gitlab") {
        // Update GitLab commit status using the configured per-host service token.
        const gitlabHost = test.project.gitlabHost ?? GITLAB_HOST
        const hostConfig = getGitLabHostConfig(gitlabHost)

        if (!hostConfig) {
          log.warn(
            { testId: test.id, projectId: test.project.id, gitlabHost },
            `No GitLab service token configured for host ${gitlabHost}, skipping commit status update`,
          )
          // Don't throw - allow approval/denial to succeed even if we can't update GitLab status
        } else {
          const state = status === "approved" ? "success" : "failed"
          const changeCount = testResults.filter((r) => r.diffRatio && r.diffRatio > 0).length

          await updateGitLabCommitStatus(test.project.repoId, test.commitSha, state, {
            name: gitlabStatusContext(test.project.key),
            targetUrl: `${APP_URL}/build?id=${test.id}`,
            description:
              status === "approved"
                ? `${changeCount} visual change${changeCount === 1 ? "" : "s"} approved`
                : `${changeCount} visual change${changeCount === 1 ? "" : "s"} denied`,
            host: gitlabHost,
          })

          log.info(
            {
              approvingUserId: user.id,
              testId: test.id,
              projectId: test.project.repoId,
              commitSha: test.commitSha,
              status,
              state,
            },
            `Updated GitLab commit status for ${test.toString()} with state: ${state}`,
          )
        }
      }
    } catch (err) {
      log.error(
        { userId: user.id, testId: test.id, status, err },
        `Failed to update VCS status for ${test.toString()}`,
      )
      // Don't fail the API call if VCS update fails
    }
  }

  res.json({ success: true })
}
