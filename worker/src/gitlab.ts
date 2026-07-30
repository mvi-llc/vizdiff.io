import { Gitlab } from "@gitbeaker/rest"
import https from "node:https"
import { type GitLabHostConfig, parseGitLabHosts, resolveGitLabHost } from "shared"

import { APP_URL, ENABLE_VCS_STATUS, GITLAB_HOST } from "./environment"
import { log } from "./log"

/**
 * Data stored in WorkTask for GitLab commit status updates. The service token is resolved from the
 * configured host at processing time - never stored in the task.
 */
export interface GitLabCheckData {
  projectId: number
  commitSha: string
  gitlabHost: string
}

// GitLab commit status states
export type GitLabStatusState = "pending" | "running" | "success" | "failed" | "canceled"

let cachedHosts: GitLabHostConfig[] | undefined
function getGitLabHosts(): GitLabHostConfig[] {
  cachedHosts ??= parseGitLabHosts(process.env)
  return cachedHosts
}

/** Resolve the configured service-token config for a host, or undefined if not configured. */
export function getGitLabHostConfig(host: string): GitLabHostConfig | undefined {
  return resolveGitLabHost(getGitLabHosts(), host)
}

/**
 * Get an authenticated GitLab API client for the given host config using its service token.
 */
export function getGitLabClient(cfg: GitLabHostConfig): InstanceType<typeof Gitlab> {
  return new Gitlab({
    host: cfg.host,
    token: cfg.token,
    agent: cfg.rejectUnauthorized ? undefined : new https.Agent({ rejectUnauthorized: false }),
  })
}

// GitLab rejects no-op `running` -> `running` status transitions with this message (surfaced by
// Gitbeaker either as the error message or as the nested `cause.description`).
const REDUNDANT_RUNNING_TRANSITION = "Cannot transition status via :run from :running"

/**
 * True iff the error is GitLab rejecting a `running` status update because the commit status is
 * already `running` (e.g. an upload re-processed after a worker restart). This transition is a
 * harmless no-op, so it shouldn't be logged as an error.
 */
function isRedundantRunningTransition(error: unknown, state: GitLabStatusState): boolean {
  if (state !== "running" || !(error instanceof Error)) {
    return false
  }
  if (error.message.includes(REDUNDANT_RUNNING_TRANSITION)) {
    return true
  }
  // GitbeakerRequestError nests the GitLab response message in `cause.description`
  const description = (error.cause as { description?: unknown } | undefined)?.description
  return typeof description === "string" && description.includes(REDUNDANT_RUNNING_TRANSITION)
}

/**
 * Update a GitLab commit status with the results of a screenshot test, using the configured
 * per-host service token (resolved from the WorkTask's `gitlabHost`).
 */
export async function updateGitLabCommitStatus({
  projectId,
  commitSha,
  gitlabHost,
  state,
  testId,
  name,
  description,
}: GitLabCheckData & {
  state: GitLabStatusState
  testId: number
  name: string
  description: string
}): Promise<void> {
  if (!ENABLE_VCS_STATUS) {
    log.info(`Skipping GitLab commit status update (ENABLE_VCS_STATUS not set)`)
    return
  }

  const cfg = getGitLabHostConfig(gitlabHost || GITLAB_HOST)
  if (!cfg) {
    log.warn(
      `No GitLab service token configured for host ${gitlabHost}, skipping commit status update`,
    )
    return
  }

  try {
    log.info(
      `Updating GitLab commit status for project ${projectId}, commit ${commitSha}: state=${state}`,
    )

    const client = getGitLabClient(cfg)

    await client.Commits.editStatus(projectId, commitSha, state, {
      name,
      targetUrl: `${APP_URL}/build?id=${testId}`,
      description,
    })

    log.info(
      `Successfully updated GitLab commit status for project ${projectId}, commit ${commitSha}: state=${state}`,
    )
  } catch (error) {
    const context = { gitlabHost: cfg.host, projectId, commitSha, state, name }
    if (isRedundantRunningTransition(error, state)) {
      log.debug(
        { err: error, ...context },
        "GitLab commit status already running; skipping redundant transition",
      )
    } else {
      log.error({ err: error, ...context }, "Failed to update GitLab commit status")
    }
    // Don't throw - GitLab status update failures shouldn't block the build
  }
}
