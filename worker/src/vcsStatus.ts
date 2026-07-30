import { ScreenshotTest, createSummaryForFailedBuild, gitlabStatusContext } from "shared"

import { DatabasePool } from "./database"
import { GITLAB_HOST } from "./environment"
import { updateGitHubCheckRun, type GitHubCheckData } from "./github"
import { getGitLabHostConfig, updateGitLabCommitStatus, type GitLabCheckData } from "./gitlab"
import { log } from "./log"

/** VCS check data carried in an ingest task's `data` jsonb (see api upload endpoint). */
export interface BuildCheckData {
  githubCheckData?: GitHubCheckData
  gitlabCheckData?: GitLabCheckData
}

/**
 * Coerce a jsonb-sourced id to a finite number. Bigint-backed columns (repo ids, installation
 * ids) surface as strings through TypeORM, and those values flow into the stored task data.
 */
function asFiniteNumber(value: unknown): number | undefined {
  const num = typeof value === "string" && value !== "" ? Number(value) : value
  return typeof num === "number" && Number.isFinite(num) ? num : undefined
}

/** Narrow an unknown value to a GitHubCheckData if it has the right shape. */
function asGitHubCheckData(value: unknown): GitHubCheckData | undefined {
  if (typeof value !== "object" || value == null) {
    return undefined
  }
  const data = value as Record<string, unknown>
  const checkRunId = asFiniteNumber(data.checkRunId)
  const installationId = asFiniteNumber(data.installationId)
  if (
    typeof data.owner === "string" &&
    typeof data.repo === "string" &&
    checkRunId != undefined &&
    installationId != undefined
  ) {
    return { owner: data.owner, repo: data.repo, checkRunId, installationId }
  }
  return undefined
}

/** Narrow an unknown value to a GitLabCheckData if it has the right shape. */
function asGitLabCheckData(value: unknown): GitLabCheckData | undefined {
  if (typeof value !== "object" || value == null) {
    return undefined
  }
  const data = value as Record<string, unknown>
  const projectId = asFiniteNumber(data.projectId)
  if (
    projectId != undefined &&
    typeof data.commitSha === "string" &&
    typeof data.gitlabHost === "string"
  ) {
    return { projectId, commitSha: data.commitSha, gitlabHost: data.gitlabHost }
  }
  return undefined
}

/**
 * Parse a task_queue `data` jsonb payload into its VCS check data, or undefined when it carries
 * none. Exported so callers that delete the queue row (`DELETE ... RETURNING data`) can hand the
 * salvaged data straight to {@link postBuildFailedStatus}.
 */
export function parseBuildCheckData(data: unknown): BuildCheckData | undefined {
  if (typeof data !== "object" || data == null) {
    return undefined
  }
  const obj = data as Record<string, unknown>
  const githubCheckData = asGitHubCheckData(obj.githubCheckData)
  const gitlabCheckData = asGitLabCheckData(obj.gitlabCheckData)
  if (!githubCheckData && !gitlabCheckData) {
    return undefined
  }
  return { githubCheckData, gitlabCheckData }
}

/**
 * Try to recover the VCS check data from a surviving `task_queue` row for this build (the api
 * stores `githubCheckData` / `gitlabCheckData` in the task's `data` jsonb).
 */
async function checkDataFromTaskQueue(
  screenshotTestId: number,
): Promise<BuildCheckData | undefined> {
  const client = await DatabasePool()
  try {
    const res = await client.query(
      `SELECT data FROM task_queue
       WHERE screenshot_test_id = $1 AND task_type = 'ingest_storybook'
       ORDER BY id DESC
       LIMIT 1`,
      [screenshotTestId],
    )
    if (res.rowCount === 0) {
      return undefined
    }
    const { data } = res.rows[0] as { data: unknown }
    return parseBuildCheckData(data)
  } finally {
    client.release()
  }
}

/**
 * Reconstruct the VCS check data from the project + screenshot test fields when the task row is
 * gone. GitHub needs the stored check run id (`vcs_status_id`) plus the app installation for the
 * repo owner; GitLab needs only the repo id, commit sha, and host.
 */
async function reconstructCheckData(
  screenshotTest: ScreenshotTest,
): Promise<BuildCheckData | undefined> {
  const project = screenshotTest.project

  if (project.vcsProvider === "github") {
    // Without a stored check run id there is nothing to update. bigint columns surface as
    // strings through TypeORM, so coerce.
    const checkRunId = asFiniteNumber(screenshotTest.vcsStatusId)
    if (checkRunId == undefined || checkRunId <= 0) {
      return undefined
    }
    const [owner, repo] = project.repoUrl.split("/").slice(-2)
    if (!owner || !repo) {
      return undefined
    }
    // Resolve the GitHub App installation for the repo owner, scoped to the project owner's
    // accessible installations (mirrors the api's getInstallationForOrg()).
    const client = await DatabasePool()
    try {
      const res = await client.query(
        `SELECT inst.installation_id
         FROM github_installations inst
         LEFT JOIN user_github_installations ui ON ui.installation_id = inst.id
         WHERE (ui.user_id = $1 OR inst.creator_id = $1) AND inst.account_name = $2
         LIMIT 1`,
        [project.user.id, owner],
      )
      if (res.rowCount === 0) {
        return undefined
      }
      const installationId = asFiniteNumber(
        (res.rows[0] as { installation_id: number | string }).installation_id,
      )
      if (installationId == undefined) {
        return undefined
      }
      return { githubCheckData: { owner, repo, checkRunId, installationId } }
    } finally {
      client.release()
    }
  }

  const repoId = asFiniteNumber(project.repoId)
  if (repoId != undefined && screenshotTest.commitSha) {
    return {
      gitlabCheckData: {
        projectId: repoId,
        commitSha: screenshotTest.commitSha,
        gitlabHost: project.gitlabHost ?? GITLAB_HOST,
      },
    }
  }

  return undefined
}

/**
 * Best-effort: post a "failed" VCS status (GitHub check run / GitLab commit status) for a build
 * that has been marked failed outside the normal ingest flow — the fatal fast-fail path, the
 * startup orphan reclaim, and the stuck-build sweeper (issue #451).
 *
 * Check data resolution order: the explicit `checkData` param (fatal path, where the ingest still
 * holds it) → a surviving `task_queue` row's `data` jsonb → reconstruction from the project and
 * screenshot test fields. If none of these yields usable data, the update is skipped with a log —
 * the database status flip is the invariant; status posting is best-effort. Never throws.
 */
export async function postBuildFailedStatus(
  screenshotTest: ScreenshotTest,
  reason: string,
  checkData?: BuildCheckData,
): Promise<void> {
  try {
    const resolved =
      checkData?.githubCheckData || checkData?.gitlabCheckData
        ? checkData
        : ((await checkDataFromTaskQueue(screenshotTest.id)) ??
          (await reconstructCheckData(screenshotTest)))

    if (!resolved?.githubCheckData && !resolved?.gitlabCheckData) {
      log.warn(
        `Cannot post failed VCS status for build ${screenshotTest.id}: no check data available`,
      )
      return
    }

    if (resolved.githubCheckData) {
      try {
        await updateGitHubCheckRun({
          ...resolved.githubCheckData,
          testId: screenshotTest.id,
          status: "completed",
          conclusion: "failure",
          title: "⚠️ Failed to render storybook components.",
          summary: createSummaryForFailedBuild(screenshotTest, reason),
        })
      } catch (error) {
        log.error(error, `Failed to update GitHub check run for failed build ${screenshotTest.id}`)
      }
      return
    }

    if (resolved.gitlabCheckData) {
      const gitlabHost = screenshotTest.project.gitlabHost ?? resolved.gitlabCheckData.gitlabHost
      if (!getGitLabHostConfig(gitlabHost)) {
        log.warn(
          `Cannot post failed GitLab commit status for build ${screenshotTest.id}: no service token configured for host ${gitlabHost}`,
        )
        return
      }
      // updateGitLabCommitStatus never throws (it logs failures internally).
      await updateGitLabCommitStatus({
        ...resolved.gitlabCheckData,
        gitlabHost,
        state: "failed",
        testId: screenshotTest.id,
        // Include the project key so multiple projects on one repo (monorepo) report independent
        // statuses on the same commit.
        name: gitlabStatusContext(screenshotTest.project.key),
        description: reason.slice(0, 140),
      })
    }
  } catch (error) {
    log.error(error, `Failed to post failed VCS status for build ${screenshotTest.id}`)
  }
}
