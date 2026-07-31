import { S3Client } from "@aws-sdk/client-s3"
import { promises as fsPromises } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  TestResult,
  ScreenshotTest,
  createSummaryForBuild,
  createSummaryForFailedBuild,
  gitlabStatusContext,
  uploadTarballKey,
} from "shared"
import { Not, In } from "typeorm"

import { Database, DatabasePool } from "./database"
import {
  MAX_STORIES_PER_UPLOAD,
  S3_CLIENT_CONFIG,
  WORKER_EGRESS_BLOCK_MODE,
  WORKER_SHARD_CHUNK_SIZE,
  WORKER_SHARD_MIN_STORIES,
  WORKER_SHARDING_ENABLED,
} from "./environment"
import { updateGitHubCheckRun, type GitHubCheckData } from "./github"
import { getGitLabHostConfig, updateGitLabCommitStatus, type GitLabCheckData } from "./gitlab"
import { WORKER_ID } from "./identity"
import { log } from "./log"
import { recordBuildOutcome } from "./metrics"
import { settlePrewarmedPool } from "./pipeline"
import { installNetworkEgressBlock } from "./safeguards"
import { startStaticServer } from "./server"
import {
  completeBuild,
  createStoryBrowserPool,
  downloadAndExtractTarball,
  enqueueRenderChunks,
  fetchBaseTestResults,
  getS3BucketForProjectId,
  logBuildMemoryUsage,
  planChunks,
  renderStoriesWithWatchdog,
} from "./shard"
import { getStorybookStories, navigateToStorybook } from "./stories"
import { BuildTimeoutError } from "./timeout"
import { postBuildFailedStatus, type BuildCheckData } from "./vcsStatus"

// Re-exported from shard.ts (issue #456, Phase B moved the render internals there so the inline
// and per-chunk paths share them); kept here for existing callers/tests.
export { computeBuildTimeoutMs } from "./shard"

/**
 * Determine whether the baseline build that a render task depends on is still
 * being processed (or waiting to be processed).
 *
 * When two commits A then B land on the same branch, B's `baseCommitSha` points
 * at A. If B's render task runs before A's has finished writing `TestResult`s, B
 * would fetch an empty baseline and flag every story as "new". This helper lets
 * the worker detect that situation and defer B until A is done.
 *
 * Returns true if a `ScreenshotTest` exists for `(projectId, commitSha=baseCommitSha)`
 * whose status is still `pending` or `running` (i.e. its render task hasn't
 * produced final results yet). Returns false if the test has no base commit,
 * if there is no such build, or if every matching build has reached a terminal
 * status (results are ready, the baseline genuinely has no build, or it
 * failed) — in which case we should proceed rather than wait forever.
 */
export async function isBaselineBuildPending(screenshotTestId: number): Promise<boolean> {
  const db = await Database()
  const screenshotTestRepo = db.getRepository(ScreenshotTest)

  const screenshotTest = await screenshotTestRepo.findOneBy({ id: screenshotTestId })
  if (!screenshotTest) {
    throw new Error(`Screenshot test not found: ${screenshotTestId}`)
  }

  const baseCommitSha = screenshotTest.baseCommitSha
  if (!baseCommitSha) {
    return false
  }
  const projectId = screenshotTest.project.id

  // A build is "in flight" while it is queued (pending) or rendering (running).
  // Any other status is terminal for our purposes: no_changes / unapproved /
  // approved / denied all mean results exist; failed means it will never produce
  // results, so we must not block on it.
  const inFlightCount = await screenshotTestRepo
    .createQueryBuilder("test")
    .where("test.project_id = :projectId", { projectId })
    .andWhere("test.commit_sha = :baseCommitSha", { baseCommitSha })
    .andWhere("test.status IN (:...statuses)", { statuses: ["pending", "running"] })
    // Exclude the current test itself defensively (it should never share the
    // base commit sha, but guard against self-blocking just in case).
    .andWhere("test.id != :screenshotTestId", { screenshotTestId })
    .getCount()

  return inFlightCount > 0
}

/**
 * Best-effort fast-fail for the fatal exit path (issue #451): before the worker exits over a
 * wedged render, flip the build to "failed", remove its queue row (a wedged build is
 * non-retryable, matching BuildTimeoutError semantics — retrying would just wedge the next
 * worker), and post the failed VCS status so CI is unblocked immediately instead of waiting for
 * the stuck-build sweeper. Uses raw SQL via the pool (not TypeORM save) so the writes are
 * minimal, conditional, and cannot clobber a concurrent status transition.
 */
export async function failBuildBeforeExit(
  screenshotTestId: number,
  taskQueueId: number | undefined,
  screenshotTest: ScreenshotTest,
  checkData?: BuildCheckData,
): Promise<void> {
  const client = await DatabasePool()
  try {
    await client.query(
      `UPDATE screenshot_tests SET status = 'failed', updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'running')`,
      [screenshotTestId],
    )
    if (taskQueueId != undefined) {
      await client.query(`DELETE FROM task_queue WHERE id = $1`, [taskQueueId])
    }
  } finally {
    client.release()
  }
  await postBuildFailedStatus(
    screenshotTest,
    "Build did not unwind after exceeding the build timeout; the worker restarted",
    checkData,
  )
}

export async function ingestStorybook(
  projectId: string,
  screenshotTestId: number,
  uploadId: string,
  githubCheckData?: GitHubCheckData,
  gitlabCheckData?: GitLabCheckData,
  taskQueueId?: number,
): Promise<void> {
  log.info(`Starting storybook ingestion for project ${projectId}, upload ${uploadId}`)
  // Wall-clock start for vizdiff_worker_build_duration_seconds (issue #457): measures actual
  // processing (download through render/finalize), not time spent queued.
  const ingestStartMs = Date.now()

  // Set when this ingest hands the render off to render_story_chunk tasks (issue #456, Phase
  // B): the build deliberately stays "running" for the chunk workers, so the completion
  // aggregation and the "still running means something broke" failsafe below must both be
  // skipped.
  let shardedHandoff = false

  // Fetch the screenshot test record (project and user loaded via eager relations)
  const db = await Database()
  const screenshotTestRepo = db.getRepository(ScreenshotTest)
  const screenshotTest = await screenshotTestRepo.findOneBy({ id: screenshotTestId })
  if (!screenshotTest) {
    throw new Error(`Screenshot test not found: ${screenshotTestId}`)
  }

  // Resolve the configured GitLab service token by host at processing time (never stored in task data).
  const gitlabHost = gitlabCheckData
    ? (screenshotTest.project.gitlabHost ?? gitlabCheckData.gitlabHost)
    : undefined
  const gitlabConfigured = gitlabHost ? getGitLabHostConfig(gitlabHost) != undefined : false
  if (gitlabCheckData && !gitlabConfigured) {
    log.warn(
      { projectId: screenshotTest.project.id, gitlabHost },
      "Skipping GitLab commit status updates: no service token configured for host",
    )
  }

  // Update VCS status based on provider
  if (githubCheckData) {
    try {
      await updateGitHubCheckRun({
        owner: githubCheckData.owner,
        repo: githubCheckData.repo,
        installationId: githubCheckData.installationId,
        checkRunId: githubCheckData.checkRunId,
        testId: screenshotTestId,
        status: "queued",
        title: "Rendering storybook components…",
        summary: createSummaryForBuild(screenshotTest),
      })
    } catch (error) {
      log.error(error, "Failed to update GitHub check run to in-progress")
      // Continue with the ingest process even if the GitHub API call fails
    }
  } else if (gitlabCheckData && gitlabConfigured && gitlabHost) {
    await updateGitLabCommitStatus({
      ...gitlabCheckData,
      gitlabHost,
      state: "running",
      testId: screenshotTestId,
      // Include the project key so multiple projects on one repo (monorepo) report independent
      // statuses on the same commit.
      name: gitlabStatusContext(screenshotTest.project.key),
      description: "Rendering storybook components…",
    })
  }

  // Clean up previous test results for the same commit/branch
  if (screenshotTest.commitSha && screenshotTest.branch) {
    log.info(`Cleaning up previous test results for the same commit/branch if they exist`)

    // Use a transaction to ensure atomicity
    await db.transaction(async (transactionalEntityManager) => {
      const testResultRepo = transactionalEntityManager.getRepository(TestResult)
      const screenshotTestRepoTx = transactionalEntityManager.getRepository(ScreenshotTest)

      // Find previous screenshot tests with the same commit and branch
      const previousTests = await screenshotTestRepoTx.find({
        where: {
          commitSha: screenshotTest.commitSha,
          branch: screenshotTest.branch,
          project: { id: screenshotTest.project.id },
          id: Not(screenshotTest.id), // Exclude current test
        },
      })

      // Delete test results for these previous tests
      if (previousTests.length > 0) {
        const previousTestIds = previousTests.map((test) => test.id)
        const deleteResult = await testResultRepo.delete({
          screenshotTest: { id: In(previousTestIds) },
        })

        log.info(
          `Deleted ${deleteResult.affected ?? 0} test results from ${previousTests.length} previous test runs for the same commit`,
        )
      }
    })
  }

  // Initialize S3 client
  const s3Client = new S3Client(S3_CLIENT_CONFIG)
  const bucket = await getS3BucketForProjectId(projectId)
  const key = uploadTarballKey(projectId, uploadId)
  log.debug(`Using S3 bucket: ${bucket}, key: ${key}`)

  // Create temp directory for extraction
  const tmpDir = path.join(os.tmpdir(), `storybook-${uploadId}`)
  log.debug(`Creating temporary directory: ${tmpDir}`)
  await fsPromises.mkdir(tmpDir, { recursive: true })

  // Update the screenshot test status to running and record this worker as its owner (issue
  // #451) so a restarting worker can reclaim the build if this process dies mid-render.
  screenshotTest.status = "running"
  screenshotTest.workerId = WORKER_ID
  await screenshotTestRepo.save(screenshotTest)

  try {
    // Build a pool of independent headless-Chrome sessions so stories render concurrently
    // (issue #152, Phase 1b); see createStoryBrowserPool in shard.ts for the session setup
    // (safeguards, render-state hook, recycling, dead-session replacement).
    //
    // Prewarm (issue #456): pool creation is kicked off BEFORE the tarball download so all N
    // Chrome sessions launch concurrently with the download + extraction instead of serially
    // after them. settlePrewarmedPool joins the two: if the download/extract fails first, the
    // pool is awaited and destroyed so an early failure never leaks Chrome processes.
    const poolPromise = createStoryBrowserPool(tmpDir)

    const downloadAndExtract = async (): Promise<void> => {
      await downloadAndExtractTarball({ s3Client, bucket, key, destDir: tmpDir })
    }

    const { pool } = await settlePrewarmedPool(poolPromise, downloadAndExtract())
    const primarySession = pool.sessions[0]
    if (!primarySession) {
      throw new Error("Browser pool initialized with no sessions") // unreachable: size >= 1
    }
    const primaryBrowser = primarySession.browser
    screenshotTest.browserVersion = `${primaryBrowser.capabilities.browserName}-${primaryBrowser.capabilities.platformName}-${primaryBrowser.capabilities.browserVersion}`
    log.info(
      { capabilities: primaryBrowser.capabilities, poolSize: pool.size },
      `Successfully initialized ${pool.size} WebdriverIO session(s) ${screenshotTest.browserVersion}`,
    )

    logBuildMemoryUsage("render-start", screenshotTest.id)

    const renderStorybook = async (): Promise<"sharded" | "rendered"> => {
      // Start a local server to serve the Storybook files
      const { server, port } = await startStaticServer(tmpDir)

      // Install the network egress boundary on EVERY pooled session so an untrusted story
      // bundle cannot exfiltrate data. Must run before navigating to any story. Sessions created
      // later as replacements (probe failure / recycling, issues #450/#453) get the same boundary
      // via the pool's session-init callback. In the default "resolver" mode (issue #473) this
      // is a no-op — enforcement lives in the Chrome launch args (hardenedChromeArgs) — while
      // the interception modes install a BiDi intercept per session.
      const origin = `http://localhost:${port}`
      pool.setSessionInit((browser) =>
        installNetworkEgressBlock(browser, origin, WORKER_EGRESS_BLOCK_MODE),
      )
      await Promise.all(
        pool.sessions.map((session) =>
          installNetworkEgressBlock(session.browser, origin, WORKER_EGRESS_BLOCK_MODE),
        ),
      )

      try {
        // Discovery phase. Runs BEFORE the build watchdog (issue #452): navigation, story
        // discovery, and the baseline prefetch each carry their own bounded internal timeouts
        // (10-30 s), and the whole-build ceiling can only be derived once the story count is
        // known.
        //
        // Discover the stories with the primary session (single-threaded, before the concurrent
        // render phase begins, so it doesn't contend with the pool).
        await primaryBrowser.setViewport({ width: 1200, height: 900, devicePixelRatio: 1 })

        // Navigate to the Storybook iframe and wait for stories to load
        await navigateToStorybook(primaryBrowser, port)

        // Get the loaded stories (validated: identifier length caps applied per story)
        const stories = await getStorybookStories(primaryBrowser)

        const storyCount = Object.keys(stories).length
        if (storyCount === 0) {
          throw new Error("Storybook loaded but contains no stories")
        }

        // Guard against pathological uploads with a runaway number of stories.
        if (MAX_STORIES_PER_UPLOAD > 0 && storyCount > MAX_STORIES_PER_UPLOAD) {
          throw new Error(
            `Storybook contains too many stories: ${storyCount} (max ${MAX_STORIES_PER_UPLOAD}). ` +
              `Set MAX_STORIES_PER_UPLOAD to raise this limit.`,
          )
        }

        log.info(`Found ${storyCount} stories to process`)

        // Persist the expected story count (issue #456, Phase B) BEFORE any render task can
        // finish: sharded completion is "count of distinct story results >= expected". Also
        // written on the inline path, where it is informational.
        screenshotTest.expectedStoryCount = storyCount
        await screenshotTestRepo.save(screenshotTest)

        // Cross-worker sharding (issue #456, Phase B): for a large build, enqueue one
        // render_story_chunk task per chunk of story ids and return with the build left
        // "running" (the VCS running status is already posted). Any worker — including this
        // one — claims chunks; the last-finishing chunk reconciles completion and posts the
        // final VCS status.
        if (WORKER_SHARDING_ENABLED && storyCount >= WORKER_SHARD_MIN_STORIES) {
          const chunks = planChunks(Object.keys(stories), WORKER_SHARD_CHUNK_SIZE)
          log.info(
            `Sharding build ${screenshotTest.id} (#${screenshotTest.buildNumber}): ` +
              `${storyCount} stories across ${chunks.length} chunk(s) of up to ` +
              `${WORKER_SHARD_CHUNK_SIZE}`,
          )
          await enqueueRenderChunks(screenshotTest, projectId, uploadId, chunks, {
            githubCheckData,
            gitlabCheckData,
          })
          // Release single-worker ownership: chunks are rendered by many workers, so neither
          // this worker's startup orphan reclaim nor its graceful-shutdown reset (issue #451)
          // should treat the still-running build as its own.
          screenshotTest.workerId = null
          await screenshotTestRepo.save(screenshotTest)
          return "sharded"
        }

        // Inline (unsharded) path: prefetch baselines and render everything in this task.
        const testResultTable = db.getRepository(TestResult)
        const baseTestResults = await fetchBaseTestResults(screenshotTest)

        // Render through the shared watchdog-guarded capture/finalize fan-out (issues #152/#452/
        // #456; see renderStoriesWithWatchdog in shard.ts). On a wedged render the worker exits;
        // the fatal cleanup fails the build, deletes the queue row, and posts the failed VCS
        // status first (issue #451).
        const testResults = await renderStoriesWithWatchdog({
          pool,
          stories: Object.values(stories),
          screenshotTest,
          baseTestResults,
          bucket,
          tmpDir,
          projectId,
          uploadId,
          port,
          s3Client,
          testResultTable,
          fatalCleanup: () =>
            failBuildBeforeExit(screenshotTestId, taskQueueId, screenshotTest, {
              githubCheckData,
              gitlabCheckData,
            }),
        })
        log.info(
          `Successfully processed all ${Object.keys(stories).length} stories for test ${screenshotTest.id} (build #${screenshotTest.buildNumber})`,
        )

        let changeCount = 0
        for (const testResult of testResults) {
          if (testResult.changeStatus !== "unchanged") {
            changeCount++
          }
        }

        // Update the screenshot test status to completed
        const startedSec = screenshotTest.createdAt.getTime() / 1000
        screenshotTest.status = changeCount > 0 ? "unapproved" : "no_changes"
        screenshotTest.buildDurationSec = Date.now() / 1000 - startedSec
        screenshotTest.totalChanges = changeCount
        await screenshotTestRepo.save(screenshotTest)

        // Update VCS status with the build results (shared with the sharded completion path;
        // reads the upserted TestResult rows from the database).
        await completeBuild(screenshotTest, { githubCheckData, gitlabCheckData })
        return "rendered"
      } finally {
        log.debug("Shutting down local server")
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    try {
      // The render phase. Story discovery runs first under its own per-step timeouts; the
      // concurrent render fan-out inside is guarded by the build watchdog (progress stall +
      // derived whole-build ceiling, issue #452).
      shardedHandoff = (await renderStorybook()) === "sharded"
      if (!shardedHandoff) {
        recordBuildOutcome("completed", (Date.now() - ingestStartMs) / 1000)
      }
    } finally {
      log.debug("Closing WebdriverIO browser session pool")
      // Sessions may already be gone if a timeout abort closed them; destroyAll tolerates that so
      // we never mask the original error with a teardown failure.
      await pool.destroyAll()
      logBuildMemoryUsage("render-end", screenshotTest.id)
    }
  } catch (error) {
    log.error(
      error,
      `Failed to process storybook in test ${screenshotTest.id} (build #${screenshotTest.buildNumber})`,
    )
    // Build metrics (issue #457): "aborted" = the build watchdog fired (whole-build ceiling or
    // progress stall, both BuildTimeoutError); everything else is "failed".
    recordBuildOutcome(
      error instanceof BuildTimeoutError ? "aborted" : "failed",
      (Date.now() - ingestStartMs) / 1000,
    )
    screenshotTest.status = "failed"
    await screenshotTestRepo.save(screenshotTest)

    // Update VCS status with failure
    if (githubCheckData) {
      try {
        await updateGitHubCheckRun({
          owner: githubCheckData.owner,
          repo: githubCheckData.repo,
          installationId: githubCheckData.installationId,
          checkRunId: githubCheckData.checkRunId,
          testId: screenshotTestId,
          status: "completed",
          conclusion: "failure",
          title: "⚠️ Failed to render storybook components.",
          summary: createSummaryForFailedBuild(screenshotTest, error),
        })
      } catch (githubError) {
        log.error(githubError, "Failed to update GitHub check run to failure")
      }
    } else if (gitlabCheckData && gitlabConfigured && gitlabHost) {
      await updateGitLabCommitStatus({
        ...gitlabCheckData,
        gitlabHost,
        state: "failed",
        testId: screenshotTestId,
        name: gitlabStatusContext(screenshotTest.project.key),
        description: "Failed to render storybook components",
      })
    }

    throw error
  } finally {
    // Cleanup
    log.debug(`Cleaning up temporary directory: ${tmpDir}`)
    await fsPromises.rm(tmpDir, { recursive: true, force: true })

    // If status is still "running", something went wrong without throwing an error — unless
    // this ingest deliberately handed off to render_story_chunk tasks (issue #456, Phase B),
    // in which case "running" is the correct hand-off state.
    if (!shardedHandoff && screenshotTest.status === "running") {
      screenshotTest.status = "failed"
      await screenshotTestRepo.save(screenshotTest)

      // Update VCS status with cancelled
      if (githubCheckData) {
        try {
          await updateGitHubCheckRun({
            owner: githubCheckData.owner,
            repo: githubCheckData.repo,
            installationId: githubCheckData.installationId,
            checkRunId: githubCheckData.checkRunId,
            testId: screenshotTestId,
            status: "completed",
            conclusion: "cancelled",
            title: "Storybook rendering was cancelled or timed out.",
            summary: createSummaryForFailedBuild(screenshotTest, "Cancelled or timed out"),
          })
        } catch (error) {
          log.error(error, "Failed to update GitHub check run to cancelled")
        }
      } else if (gitlabCheckData && gitlabConfigured && gitlabHost) {
        await updateGitLabCommitStatus({
          ...gitlabCheckData,
          gitlabHost,
          state: "canceled",
          testId: screenshotTestId,
          name: gitlabStatusContext(screenshotTest.project.key),
          description: "Storybook rendering was cancelled or timed out",
        })
      }
    }

    log.info(
      `Storybook ingestion ${shardedHandoff ? "handed off to render chunks" : "completed"} for ` +
        `${screenshotTest.id} (build #${screenshotTest.buildNumber}) with status: ${screenshotTest.status}`,
    )
  }
}
