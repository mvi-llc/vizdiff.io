import crypto from "crypto"
import {
  createMarkdownForBuildApproval,
  githubCheckRunName,
  Project,
  ScreenshotTest,
  TestResult,
} from "shared"

import { Database } from "../database"
import {
  APP_URL,
  ENABLE_VCS_STATUS,
  GITHUB_WEBHOOK_SECRET,
  GITLAB_WEBHOOK_SECRET,
} from "../environment"
import { getOctokitForInstallation } from "../github"
import { getGitLabHostConfig } from "../gitlab"
import { log } from "../log"
import { buildImageUrlResolver } from "../s3"
import type { CheckRunPayload } from "../schemas/CheckRunPayload"
import type { CheckSuitePayload } from "../schemas/CheckSuitePayload"
import type { RequestWithRawBody, DefaultResponse } from "../types"

/**
 * Timing-safe string comparison that treats a length mismatch (which makes
 * `crypto.timingSafeEqual` throw) as a failed match instead of an error.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    // Lengths don't match
    return false
  }
}

/**
 * Verify the GitHub webhook signature
 */
export function verifyWebhookSignature(
  payload: Buffer,
  signature: string | undefined,
  signingSecret: string,
): boolean {
  if (!signature) {
    return false
  }

  const pairs = signature.split(",").map((pair) => pair.trim().split("="))
  const sigMap = new Map(pairs as [string, string][])

  // Check for both signature types
  const sha1Sig = sigMap.get("sha1")
  const sha256Sig = sigMap.get("sha256")

  if (sha256Sig) {
    // Prefer SHA-256 if available
    const hmac = crypto.createHmac("sha256", signingSecret)
    const digest = hmac.update(payload).digest("hex")
    return timingSafeStringEqual(sha256Sig, digest)
  } else if (sha1Sig) {
    // Fallback to SHA-1
    const hmac = crypto.createHmac("sha1", signingSecret)
    const digest = hmac.update(payload).digest("hex")
    return timingSafeStringEqual(sha1Sig, digest)
  }

  return false
}

/**
 * Verify the GitLab webhook token.
 * GitLab uses a simple token comparison via the X-Gitlab-Token header.
 */
export function verifyGitLabWebhookToken(
  receivedToken: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (!receivedToken || !expectedToken) {
    return false
  }

  // Handle case where header might be an array
  const token = Array.isArray(receivedToken) ? receivedToken[0] : receivedToken

  if (!token) {
    return false
  }

  // Use timing-safe comparison to prevent timing attacks
  return timingSafeStringEqual(token, expectedToken)
}

/**
 * Escape special regex characters in a string so it can be used as a literal pattern
 * This prevents regex injection attacks when interpolating user input into regex patterns
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Find all projects for a repository URL (supports both GitHub and GitLab).
 * A repo can host multiple VizDiff projects (monorepo support, issue #443), so webhook handlers
 * must fan events out to every match instead of assuming a single project.
 */
export async function findProjectsByRepo(
  repoOwner: string,
  repoName: string,
  provider: "github" | "gitlab" = "github",
): Promise<Project[]> {
  const db = await Database()
  const projectRepo = db.getRepository(Project)

  // Look for projects with matching repository URL
  // URLs can be in forms like:
  // - https://github.com/owner/repo
  // - https://github.com/owner/repo.git
  // - https://gitlab.com/group/project
  const projects = await projectRepo.find({ where: { vcsProvider: provider } })

  const hostPattern = provider === "gitlab" ? "gitlab" : "github"
  // Escape special regex characters in repoOwner and repoName to prevent regex injection
  const escapedOwner = escapeRegex(repoOwner)
  const escapedName = escapeRegex(repoName)
  return projects.filter((project) => {
    const url = project.repoUrl.toLowerCase()
    const repoPattern = new RegExp(
      `${hostPattern}[^/]*[/:]${escapedOwner}/${escapedName}(\\.git)?$`,
      "i",
    )
    return repoPattern.test(url)
  })
}

/** Extract the origin (scheme://host[:port]) from a GitLab web URL. */
function originFromWebUrl(webUrl: string | undefined): string | undefined {
  if (!webUrl) {
    return undefined
  }
  try {
    return new URL(webUrl).origin
  } catch {
    return undefined
  }
}

/**
 * Find all projects for a GitLab project ID and host. Webhooks are matched by the host derived
 * from the payload's `project.web_url` origin to prevent cross-host mismatches when serving
 * multiple instances. Multiple rows can match one repo (monorepo support, issue #443), so
 * handlers fan the event out to every project.
 */
export async function findProjectsByGitLabId(
  gitlabProjectId: number,
  gitlabHost: string | undefined,
): Promise<Project[]> {
  const db = await Database()
  const projectRepo = db.getRepository(Project)
  return await projectRepo.find({
    where: {
      vcsProvider: "gitlab",
      repoId: gitlabProjectId,
      ...(gitlabHost ? { gitlabHost } : {}),
    },
  })
}

export async function githubWebhook(req: RequestWithRawBody, res: DefaultResponse): Promise<void> {
  // Get the raw body from Express
  const rawBody = req.rawBody

  if (!rawBody || !req.body) {
    log.error("Missing request body")
    res.status(400).json({ error: "Missing request body" })
    return
  }

  // Verify webhook signature
  const signature = req.headers["x-hub-signature-256"] ?? req.headers["x-hub-signature"]
  const isValidSignature = verifyWebhookSignature(
    rawBody,
    typeof signature === "string" ? signature : undefined,
    GITHUB_WEBHOOK_SECRET,
  )

  if (!isValidSignature) {
    log.error("Invalid webhook signature")
    res.status(401).json({ error: "Invalid signature" })
    return
  }

  // Check for the GitHub event type
  const eventName = req.headers["x-github-event"]
  if (eventName === "check_suite") {
    const payload = req.body as CheckSuitePayload
    if (payload.action === "requested" || payload.action === "rerequested") {
      await githubCheckSuiteRequested(res, payload)
    } else {
      log.info(`Ignoring GitHub check_suite action: "${payload.action}"`)
      res.status(202).json({ message: "Action ignored" })
    }
  } else if (eventName === "check_run") {
    const payload = req.body as CheckRunPayload
    if (payload.action === "requested_action") {
      await githubCheckRunRequestedAction(res, payload)
    } else {
      log.info(`Ignoring GitHub check_run action: "${payload.action}"`)
      res.status(202).json({ message: "Action ignored" })
    }
  } else {
    log.info(`Ignoring GitHub webhook event type: "${eventName}"`)
    res.status(202).json({ message: "Event ignored" })
    return
  }
}

async function githubCheckSuiteRequested(
  res: DefaultResponse,
  payload: CheckSuitePayload,
): Promise<void> {
  let subject = "(unknown)"
  try {
    const action = payload.action

    // Only process requested or rerequested_actions
    if (action !== "requested" && action !== "rerequested") {
      log.debug(`Ignoring check_suite action: ${action}`)
      res.status(202).json({ message: "Action ignored" })
      return
    }

    const headSha = payload.check_suite.head_sha
    const branch = payload.check_suite.head_branch || "unknown"
    const repoOwner = payload.repository.owner.login
    const repoName = payload.repository.name
    const installationId = payload.installation.id

    if (!headSha || !repoOwner || !repoName || !installationId) {
      log.error("Missing required webhook payload fields")
      res.status(400).json({ error: "Missing required payload fields" })
      return
    }

    subject = `${repoOwner}/${repoName}#${headSha} (branch: ${branch})`
    log.info(`Processing check_suite "${action}" event for ${subject}`)

    // Find the projects associated with this repository (a monorepo can host several)
    const projects = await findProjectsByRepo(repoOwner, repoName)
    if (projects.length === 0) {
      log.error(`No project found for ${subject}`)
      res.status(404).json({ error: "No project found for this repository" })
      return
    }

    // Fan the event out to every project for this repo
    const db = await Database()
    const screenshotTestRepository = db.getRepository(ScreenshotTest)
    for (const project of projects) {
      // Check if a screenshot test already exists for this commit SHA
      const existingTest = await screenshotTestRepository.findOne({
        where: {
          commitSha: headSha,
          project: { id: project.id },
        },
      })

      if (existingTest?.status === "failed") {
        // TASK: Queue a worker task to re-run the screenshot test
        log.warn(
          `TODO: Re-run screenshot test after failure for ${subject} (project ${project.id})`,
        )
      } else if (action === "rerequested") {
        log.warn(
          `GitHub check_suite re-requested for ${subject} (project ${project.id}), current status: ${existingTest?.status ?? "(none)"}`,
        )
      } else {
        // This is the normal case, a check_suite webhook comes in before the storybook upload
        log.info(
          `GitHub check_suite (action=${action}) received for ${subject} (project ${project.id})`,
        )
      }
    }

    res.status(200).json({
      message: "Check suite event processed successfully",
    })
  } catch (error) {
    log.error(error, `Error processing check_suite webhook for ${subject}`)
    res.status(500).json({ error: "Internal server error" })
  }
}

async function githubCheckRunRequestedAction(
  res: DefaultResponse,
  payload: CheckRunPayload,
): Promise<void> {
  const githubCheckRunId = payload.check_run.id

  // Extract the requested_action identifier
  const status = payload.requested_action?.identifier
  if (!status) {
    log.error("Missing requested_action identifier")
    res.status(400).json({ error: "Missing requested_action identifier" })
    return
  }

  // Extract the owner and repo from the repository full_name
  const [owner, repo] = payload.repository.full_name.split("/")
  if (!owner || !repo) {
    log.error(`Invalid repository full_name: ${payload.repository.full_name}`)
    res.status(400).json({ error: "Invalid repository full_name" })
    return
  }

  // Retrieve the test ID from the check_run payload
  const testId = Number(payload.check_run.external_id)
  if (!testId || isNaN(testId)) {
    log.error(`Missing or invalid test ID: "${payload.check_run.external_id}"`)
    res.status(400).json({ error: "Missing or invalid test ID" })
    return
  }

  // Validate the requested_action identifier
  if (status !== "approved" && status !== "denied") {
    log.error(`Invalid requested_action identifier: "${status}"`)
    res.status(400).json({ error: "Invalid requested_action identifier" })
    return
  }

  log.info(`GitHub check_run requested_action "${status}" for test ${testId}`)

  // Look up the screenshot test
  const db = await Database()
  const screenshotTestRepository = db.getRepository(ScreenshotTest)
  const test = await screenshotTestRepository.findOne({
    where: { id: testId },
  })

  if (!test) {
    log.error(`Screenshot test not found for ID: ${testId}`)
    res.status(400).json({ error: "Screenshot test not found" })
    return
  }

  if (test.status !== "unapproved") {
    log.error(`Cannot approve/deny screenshot test ${testId}, status is ${test.status}`)
    res.status(400).json({ error: "Screenshot test is not unapproved" })
    return
  }

  // Retrieve test results for this screenshot test
  const testResultTable = db.getRepository(TestResult)
  const testResults = await testResultTable.find({
    where: { screenshotTest: { id: test.id } },
  })

  // Update the screenshot test status
  test.status = status
  test.githubCheckRunId ??= githubCheckRunId
  await screenshotTestRepository.save(test)

  if (ENABLE_VCS_STATUS) {
    // Update GitHub check run
    const resolveImageUrl = await buildImageUrlResolver(testResults)
    const { title, summary, text } = createMarkdownForBuildApproval(
      test,
      testResults,
      payload.sender.login,
      resolveImageUrl,
    )

    // Create a new check run with the success or failure conclusion
    const conclusion = status === "approved" ? "success" : "failure"
    const octokit = await getOctokitForInstallation(payload.installation.id)
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
      `Created GitHub check run ${result.data.id} from webhook for ${test.toString()} with conclusion: ${conclusion}`,
    )
  }
}

// =============================================================================
// GitLab Webhook Handling
// =============================================================================

/**
 * GitLab webhook payload types
 */
interface GitLabPushPayload {
  object_kind: "push"
  event_name: string
  before: string
  after: string
  ref: string
  checkout_sha: string
  project_id: number
  project: {
    id: number
    name: string
    path_with_namespace: string
    web_url: string
  }
  commits: Array<{
    id: string
    message: string
    author: { name: string; email: string }
  }>
  user_name: string
  user_username: string
}

interface GitLabMergeRequestPayload {
  object_kind: "merge_request"
  event_type: string
  project: {
    id: number
    name: string
    path_with_namespace: string
    web_url: string
  }
  object_attributes: {
    id: number
    iid: number
    source_branch: string
    target_branch: string
    last_commit: {
      id: string
      message: string
    }
    state: string
    action: string
  }
  user: {
    name: string
    username: string
  }
}

interface GitLabPipelinePayload {
  object_kind: "pipeline"
  object_attributes: {
    id: number
    ref: string
    sha: string
    status: string
  }
  project: {
    id: number
    path_with_namespace: string
    web_url: string
  }
  commit: {
    id: string
    message: string
  }
}

type GitLabWebhookPayload = GitLabPushPayload | GitLabMergeRequestPayload | GitLabPipelinePayload

/**
 * Handle GitLab webhook events
 */
export async function gitlabWebhook(req: RequestWithRawBody, res: DefaultResponse): Promise<void> {
  // Validate payload has object_kind before type assertion
  const body = req.body as unknown
  if (
    !body ||
    typeof body !== "object" ||
    !("object_kind" in body) ||
    typeof (body as { object_kind?: unknown }).object_kind !== "string"
  ) {
    log.error("Missing or invalid GitLab webhook payload")
    res.status(400).json({ error: "Missing or invalid payload" })
    return
  }

  // Every event type we handle carries a `project` object; reject payloads without one before
  // dereferencing it (a malformed event must not produce a TypeError → 500).
  const projectField = (body as { project?: { web_url?: unknown } }).project
  if (!projectField || typeof projectField !== "object") {
    log.error("GitLab webhook payload is missing the project object")
    res.status(400).json({ error: "Missing project in payload" })
    return
  }

  const payload = body as GitLabWebhookPayload
  const eventType = payload.object_kind

  // Derive the GitLab host from the payload origin and resolve its (optional) per-host secret,
  // falling back to the global GITLAB_WEBHOOK_SECRET.
  const webUrl = typeof projectField.web_url === "string" ? projectField.web_url : undefined
  const gitlabHost = originFromWebUrl(webUrl)
  const hostConfig = gitlabHost ? getGitLabHostConfig(gitlabHost) : undefined
  const expectedSecret = hostConfig?.webhookSecret ?? GITLAB_WEBHOOK_SECRET

  // Verify webhook token
  const webhookToken = req.headers["x-gitlab-token"]
  if (!expectedSecret) {
    log.warn("GitLab webhook received but no webhook secret is configured")
    res.status(500).json({ error: "GitLab webhooks not configured" })
    return
  }

  if (!verifyGitLabWebhookToken(webhookToken, expectedSecret)) {
    log.error("Invalid GitLab webhook token")
    res.status(401).json({ error: "Invalid webhook token" })
    return
  }

  log.info(`Received GitLab webhook event: ${eventType} from ${gitlabHost ?? "(unknown host)"}`)

  try {
    switch (eventType) {
      case "push":
        await handleGitLabPush(res, payload, gitlabHost)
        break
      case "merge_request":
        await handleGitLabMergeRequest(res, payload, gitlabHost)
        break
      case "pipeline":
        await handleGitLabPipeline(res, payload, gitlabHost)
        break
      default:
        log.info(`Ignoring GitLab webhook event type: "${eventType}"`)
        res.status(202).json({ message: "Event ignored" })
    }
  } catch (error) {
    log.error(error, `Error processing GitLab ${eventType} webhook`)
    res.status(500).json({ error: "Internal server error" })
  }
}

/**
 * Handle GitLab push events
 */
async function handleGitLabPush(
  res: DefaultResponse,
  payload: GitLabPushPayload,
  gitlabHost: string | undefined,
): Promise<void> {
  const projectId = payload.project_id
  const commitSha = payload.checkout_sha || payload.after
  const branch = payload.ref.replace("refs/heads/", "")

  log.info(`GitLab push event for project ${projectId}, commit ${commitSha}, branch ${branch}`)

  // Find the associated VizDiff projects (a monorepo can host several)
  const projects = await findProjectsByGitLabId(projectId, gitlabHost)
  if (projects.length === 0) {
    log.info(`No VizDiff project found for GitLab project ${projectId}`)
    res.status(200).json({ message: "No project found, event acknowledged" })
    return
  }

  // Fan the event out to every project for this repo
  const db = await Database()
  const screenshotTestRepository = db.getRepository(ScreenshotTest)
  for (const project of projects) {
    // Check if a screenshot test already exists for this commit
    const existingTest = await screenshotTestRepository.findOne({
      where: {
        commitSha,
        project: { id: project.id },
      },
    })

    if (existingTest) {
      log.info(`Screenshot test already exists for commit ${commitSha} (project ${project.id})`)
    } else {
      log.info(
        `GitLab push event received for ${payload.project.path_with_namespace}#${commitSha} (project ${project.id})`,
      )
    }
  }

  res.status(200).json({ message: "Push event processed" })
}

/**
 * Handle GitLab merge request events
 */
async function handleGitLabMergeRequest(
  res: DefaultResponse,
  payload: GitLabMergeRequestPayload,
  gitlabHost: string | undefined,
): Promise<void> {
  const projectId = payload.project.id
  const mrIid = payload.object_attributes.iid
  const action = payload.object_attributes.action
  const commitSha = payload.object_attributes.last_commit.id
  const sourceBranch = payload.object_attributes.source_branch

  log.info(
    `GitLab MR event: project ${projectId}, MR !${mrIid}, action "${action}", commit ${commitSha}`,
  )

  // Find the associated VizDiff projects (a monorepo can host several)
  const projects = await findProjectsByGitLabId(projectId, gitlabHost)
  if (projects.length === 0) {
    log.info(`No VizDiff project found for GitLab project ${projectId}`)
    res.status(200).json({ message: "No project found, event acknowledged" })
    return
  }

  // Only process relevant MR actions
  if (action !== "open" && action !== "update" && action !== "reopen") {
    log.info(`Ignoring GitLab MR action: ${action}`)
    res.status(202).json({ message: "Action ignored" })
    return
  }

  // Fan the event out to every project for this repo
  const db = await Database()
  const screenshotTestRepository = db.getRepository(ScreenshotTest)
  for (const project of projects) {
    // Check if a screenshot test exists for this commit
    const existingTest = await screenshotTestRepository.findOne({
      where: {
        commitSha,
        project: { id: project.id },
      },
    })

    if (existingTest) {
      // Update the MR number if not already set
      if (!existingTest.prNumber) {
        existingTest.prNumber = mrIid
        await screenshotTestRepository.save(existingTest)
        log.info(`Updated screenshot test ${existingTest.id} with MR !${mrIid}`)
      }
    } else {
      log.info(
        `GitLab MR event received for ${payload.project.path_with_namespace}!${mrIid} (commit ${commitSha}, branch ${sourceBranch}, project ${project.id})`,
      )
    }
  }

  res.status(200).json({ message: "Merge request event processed" })
}

/**
 * Handle GitLab pipeline events
 */
async function handleGitLabPipeline(
  res: DefaultResponse,
  payload: GitLabPipelinePayload,
  gitlabHost: string | undefined,
): Promise<void> {
  const projectId = payload.project.id
  const pipelineId = payload.object_attributes.id
  const status = payload.object_attributes.status
  const commitSha = payload.object_attributes.sha

  log.info(
    `GitLab pipeline event: project ${projectId}, pipeline ${pipelineId}, status "${status}"`,
  )

  // Find the associated VizDiff projects (a monorepo can host several)
  const projects = await findProjectsByGitLabId(projectId, gitlabHost)
  if (projects.length === 0) {
    log.info(`No VizDiff project found for GitLab project ${projectId}`)
    res.status(200).json({ message: "No project found, event acknowledged" })
    return
  }

  // We mainly log pipeline events for debugging; the actual status updates
  // happen when the storybook is uploaded via the API
  log.info(
    `GitLab pipeline ${pipelineId} for ${payload.project.path_with_namespace}#${commitSha}: ${status} (${projects.length} VizDiff project(s))`,
  )

  res.status(200).json({ message: "Pipeline event processed" })
}
