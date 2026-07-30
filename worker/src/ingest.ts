import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"
import type { Capabilities } from "@wdio/types"
import { promises as fsPromises } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import {
  TestResult,
  ScreenshotTest,
  createSummaryForBuild,
  createMarkdownForBuildResult,
  createSummaryForFailedBuild,
  gitlabStatusContext,
  uploadTarballKey,
} from "shared"
import { Not, In } from "typeorm"
import { remote } from "webdriverio"

import { createBrowserPool } from "./browserPool"
import { Database, DatabasePool } from "./database"
import { downloadWithTimeout } from "./download"
import {
  BUILD_ABORT_GRACE_MS,
  BUILD_MEMORY_WARN_BYTES,
  BUILD_TIMEOUT_FLOOR_MS,
  BUILD_TIMEOUT_MS,
  CHROMEDRIVER_PORT,
  MAX_STORIES_PER_UPLOAD,
  S3_BUCKET_NAME,
  S3_CLIENT_CONFIG,
  WORKER_CHROME_EXTRA_ARGS,
  WORKER_ENABLE_WEBGL,
  WORKER_FATAL_FAILSAFE_TIMEOUT_MS,
  WORKER_FINALIZE_CONCURRENCY,
  WORKER_FINALIZE_QUEUE_LIMIT,
  WORKER_PER_STORY_BUDGET_MS,
  WORKER_PROGRESS_TIMEOUT_MS,
  WORKER_SESSION_MAX_INFRA_FAILURES,
  WORKER_SESSION_RECYCLE_STORIES,
  WORKER_STORY_CONCURRENCY,
} from "./environment"
import { safeExtract } from "./extract"
import { updateGitHubCheckRun, type GitHubCheckData } from "./github"
import { getGitLabHostConfig, updateGitLabCommitStatus, type GitLabCheckData } from "./gitlab"
import { WORKER_ID } from "./identity"
import { log } from "./log"
import { recordBuildOutcome, recordStoryPhaseDuration, recordStoryResult } from "./metrics"
import { runStoryPipeline, settlePrewarmedPool } from "./pipeline"
import { beginBuildProgress, endBuildProgress } from "./progress"
import { buildImageUrlResolver } from "./s3"
import {
  hardenedChromeArgs,
  installBrowserSafeguards,
  installNetworkEgressBlock,
} from "./safeguards"
import { startStaticServer } from "./server"
import {
  captureStoryWithRetry,
  finalizeStoryWithRecording,
  getStorybookStories,
  navigateToStorybook,
} from "./stories"
import { installStoryRenderStateHook } from "./storyReady"
import { NonRetryableTaskError, isPermanentS3FetchError } from "./tasks"
import { BuildTimeoutError, withTimeout } from "./timeout"
import type { Story } from "./types"
import { postBuildFailedStatus, type BuildCheckData } from "./vcsStatus"
import { nodeCompatTransformRequest } from "./wdio"

/** Log resident set size, warning when it crosses the configured threshold. */
function logBuildMemoryUsage(phase: string, screenshotTestId: number): void {
  const { rss, heapUsed } = process.memoryUsage()
  const ctx = { phase, screenshotTestId, rssBytes: rss, heapUsedBytes: heapUsed }
  if (rss >= BUILD_MEMORY_WARN_BYTES) {
    log.warn(ctx, `High memory usage during build (RSS ${(rss / 1024 / 1024).toFixed(0)} MiB)`)
  } else {
    log.debug(ctx, `Build memory usage (RSS ${(rss / 1024 / 1024).toFixed(0)} MiB)`)
  }
}

/**
 * Compute the whole-build timeout ceiling (issue #452), applied to the render fan-out only
 * (story discovery runs beforehand under its own per-step timeouts).
 *
 * When `explicitEnvMs` (BUILD_TIMEOUT_MS) is set, it is returned verbatim — back-compat for
 * deployments that tuned the flat cap. Otherwise the ceiling scales with the discovered story
 * count: `max(BUILD_TIMEOUT_FLOOR_MS, ceil(storyCount * WORKER_PER_STORY_BUDGET_MS /
 * concurrency))`, so a large-but-healthy storybook is never killed just for being large. The
 * ceiling is a backstop; the progress watchdog (WORKER_PROGRESS_TIMEOUT_MS) is the primary
 * stall detector.
 */
export function computeBuildTimeoutMs(
  storyCount: number,
  concurrency: number,
  explicitEnvMs: number | undefined,
): number {
  if (explicitEnvMs != undefined) {
    return explicitEnvMs
  }
  return Math.max(
    BUILD_TIMEOUT_FLOOR_MS,
    Math.ceil((storyCount * WORKER_PER_STORY_BUDGET_MS) / Math.max(1, concurrency)),
  )
}

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
    // Initialize WebdriverIO
    log.debug("Initializing WebdriverIO in headless Chrome mode")
    const config: Capabilities.WebdriverIOConfig = {
      outputDir: path.join(tmpDir, "wdio-logs"),
      hostname: "localhost",
      // Connect to the chromedriver started by the container's start.sh (CHROMEDRIVER_PORT=4444 in
      // the image); undefined when unset so local dev lets WebdriverIO manage its own driver.
      port: CHROMEDRIVER_PORT,
      capabilities: {
        browserName: "chrome",
        // Enable WebDriver BiDi so we can install page-level rendering
        // safeguards (issue #69) via `addInitScript`.
        webSocketUrl: true,
        "goog:chromeOptions": {
          // Base flags plus hardening flags that disable risky browser features
          // (WebRTC, background networking, etc.) when executing untrusted
          // story bundles, plus opt-in software WebGL and operator extra args
          // (issue #447). See `safeguards.ts`.
          args: hardenedChromeArgs(
            ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            { enableWebgl: WORKER_ENABLE_WEBGL, extraArgs: WORKER_CHROME_EXTRA_ARGS },
          ),
        },
      },
      logLevel: "warn",
      // Fail HTTP-level WebDriver requests against a dead driver faster than the 120 s default,
      // so session replacement (issue #450) is detected and resolved promptly. (The 60 s BiDi
      // command timeout is hardcoded in the webdriver package and not configurable here.)
      connectionRetryTimeout: 30_000,
      // Strip forbidden headers WebdriverIO injects so sessions work under
      // Node 26's undici 7 (see wdio.ts).
      transformRequest: nodeCompatTransformRequest,
    }
    // Build a pool of independent headless-Chrome sessions so stories render concurrently
    // (issue #152, Phase 1b). Pool size == WORKER_STORY_CONCURRENCY (default 1). Each session gets
    // the page-level safeguards installed up front (disable real-time transports + off-origin
    // fetch/XHR/window.open at the JS layer) before it navigates to any untrusted story; the hard
    // network egress boundary is installed per session below, once the static-server origin is known.
    // Sessions are recycled after WORKER_SESSION_RECYCLE_STORIES stories (bounding Chrome's
    // cumulative memory growth, issue #453) and replaced after WORKER_SESSION_MAX_INFRA_FAILURES
    // consecutive infra failures (dead-session recovery, issue #450).
    //
    // Prewarm (issue #456): pool creation is kicked off BEFORE the tarball download so all N
    // Chrome sessions launch concurrently with the download + extraction instead of serially
    // after them. settlePrewarmedPool joins the two: if the download/extract fails first, the
    // pool is awaited and destroyed so an early failure never leaks Chrome processes.
    const poolPromise = createBrowserPool(
      WORKER_STORY_CONCURRENCY,
      async () => {
        const session = await remote(config)
        await installBrowserSafeguards(session)
        // Record Storybook's story-render lifecycle in the page (issue #458) so capture waits for
        // render completion instead of screenshotting an async story's loading fallback.
        await installStoryRenderStateHook(session)
        return session
      },
      {
        recycleAfterStories: WORKER_SESSION_RECYCLE_STORIES,
        maxConsecutiveInfraFailures: WORKER_SESSION_MAX_INFRA_FAILURES,
      },
    )

    const downloadAndExtract = async (): Promise<void> => {
      // Initialize the tarball download from S3
      const tarballPath = path.join(tmpDir, "storybook.tar.gz")
      log.info(`Downloading storybook build from S3 ${key} -> ${tarballPath}`)
      const getObjectCommand = new GetObjectCommand({ Bucket: bucket, Key: key })
      let response
      try {
        response = await s3Client.send(getObjectCommand)
      } catch (error) {
        // If the upload tarball is permanently gone (e.g. NoSuchKey) there is no
        // point retrying. Surface it as a non-retryable error so the worker deletes
        // the task from the queue instead of releasing the lock for backoff retries.
        // The outer catch below marks the ScreenshotTest as failed before this
        // propagates.
        if (isPermanentS3FetchError(error)) {
          const name = (error as { name?: string }).name ?? "unknown"
          throw new NonRetryableTaskError(
            `Storybook upload tarball is unavailable (${name}) at s3://${bucket}/${key}; not retrying`,
            error,
          )
        }
        throw error
      }
      if (!response.Body) {
        throw new Error("Empty response body from S3")
      }
      if (!(response.Body instanceof Readable)) {
        throw new Error(`Unexpected response.Body type ${typeof response.Body}`)
      }
      // Download the tarball to a temporary file
      await downloadWithTimeout(response.Body, tarballPath, 30 * 1000)
      log.debug(`Successfully downloaded storybook build from S3`)

      // Extract the tarball
      log.info(`Extracting storybook build to: ${tmpDir}`)
      await safeExtract(tarballPath, tmpDir)
      log.debug(`Successfully extracted storybook build`)
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

    const renderStorybook = async (): Promise<void> => {
      // Start a local server to serve the Storybook files
      const { server, port } = await startStaticServer(tmpDir)

      // Install the hard network egress boundary on EVERY pooled session: fail every off-origin
      // request (sub-resource, navigation, fetch, XHR, WebSocket, beacon) so an untrusted story
      // bundle cannot exfiltrate data. Must run before navigating to any story. Sessions created
      // later as replacements (probe failure / recycling, issues #450/#453) get the same boundary
      // via the pool's session-init callback.
      const origin = `http://localhost:${port}`
      pool.setSessionInit((browser) => installNetworkEgressBlock(browser, origin))
      await Promise.all(
        pool.sessions.map((session) => installNetworkEgressBlock(session.browser, origin)),
      )

      try {
        // Discovery phase. Runs BEFORE the build watchdog below (issue #452): navigation, story
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

        const testResultTable = db.getRepository(TestResult)

        // Fetch test results from the base commit if it exists
        const baseTestResults = new Map<string, TestResult>()
        if (screenshotTest.baseCommitSha) {
          log.info(`Fetching base test results for commit ${screenshotTest.baseCommitSha}`)
          const baseTests = await testResultTable
            .createQueryBuilder("result")
            .leftJoinAndSelect("result.screenshotTest", "test")
            // Filter by project as well as commit sha: two projects can share a commit sha
            // (forks, monorepos), and the pair lets Postgres use the
            // (project_id, commit_sha) index.
            .where("test.project_id = :projectId", { projectId: screenshotTest.project.id })
            .andWhere("test.commit_sha = :commitSha", { commitSha: screenshotTest.baseCommitSha })
            .getMany()

          for (const test of baseTests) {
            baseTestResults.set(test.storyId, test)
          }
          log.info(`Found ${baseTestResults.size} base test results`)
        }

        // Derive the whole-build ceiling now that the story count is known (issue #452): an
        // explicit BUILD_TIMEOUT_MS is used verbatim; otherwise the ceiling scales with the
        // story count so a large-but-healthy storybook is never killed by a flat cap.
        const buildTimeoutMs = computeBuildTimeoutMs(storyCount, pool.size, BUILD_TIMEOUT_MS)
        log.info(
          `Build timeout ceiling: ${buildTimeoutMs}ms for ${storyCount} stories` +
            (WORKER_PROGRESS_TIMEOUT_MS > 0
              ? `, progress watchdog: ${WORKER_PROGRESS_TIMEOUT_MS}ms`
              : ""),
        )

        // Render stories concurrently across the session pool (issue #152, Phase 1b) through the
        // two-lane capture/finalize pipeline (issue #456). Capture slots equal the pool size, so
        // a slot rarely waits on acquire(); on capture success the session is released
        // immediately and the story's S3 uploads + baseline diff + DB save run in a bounded
        // background lane (WORKER_FINALIZE_CONCURRENCY), letting the session move straight to
        // the next story. WORKER_FINALIZE_QUEUE_LIMIT caps captured-but-unfinalized stories
        // (each buffers one PNG in memory). Session checkout, health probing, infra-error retry,
        // and failure recording live inside captureStoryWithRetry/finalizeStoryWithRecording
        // (issues #450/#454): a single story's failure records a `failed` TestResult and
        // resolves, so one bad story (or one dead session) cannot abort the build.
        log.info(
          `Rendering ${Object.keys(stories).length} stories across ${pool.size} session(s) ` +
            `(finalize concurrency ${WORKER_FINALIZE_CONCURRENCY}, ` +
            `queue limit ${WORKER_FINALIZE_QUEUE_LIMIT})`,
        )

        // Track render progress (issue #452): every settled story — success or recorded failure
        // — counts as forward progress. The in-process stall watchdog polls lastProgressAtMs,
        // and a throttled last_progress_at heartbeat lets the cross-worker stuck-build sweeper
        // distinguish a large-but-healthy build from a wedged one. Stories count as complete
        // when they FINALIZE; capture completions additionally touch() the watchdog (cheap) so
        // a long finalize backlog is never mistaken for a stall.
        const progress = beginBuildProgress(screenshotTest.id, storyCount)
        let testResults: TestResult[]
        try {
          const storyInfoFor = (story: Story) => ({
            story,
            screenshotTest,
            baseTestResult: baseTestResults.get(story.id),
            bucket,
            tmpDir,
            projectId,
            uploadId,
            port,
            s3Client,
            testResultTable,
          })
          const renderAllStories = runStoryPipeline({
            stories: Object.values(stories),
            captureConcurrency: pool.size,
            finalizeConcurrency: WORKER_FINALIZE_CONCURRENCY,
            queueLimit: WORKER_FINALIZE_QUEUE_LIMIT,
            capture: async (story) => {
              const outcome = await captureStoryWithRetry({ ...storyInfoFor(story), pool })
              // Story metrics (issue #457): a `captured` outcome reports its capture-phase
              // duration (its final ok/failed outcome is recorded at finalize); a `recorded`
              // outcome IS the story's final (failed) result, so record it now.
              if (outcome.kind === "captured") {
                recordStoryPhaseDuration("capture", outcome.captured.captureDurationMs / 1000)
              } else {
                recordStoryResult(outcome.result)
              }
              return outcome
            },
            finalize: async (story, captured) => {
              const finalizeStartMs = Date.now()
              const result = await finalizeStoryWithRecording(storyInfoFor(story), captured)
              recordStoryPhaseDuration("finalize", (Date.now() - finalizeStartMs) / 1000)
              recordStoryResult(result)
              return result
            },
            hooks: {
              onCaptureComplete: () => {
                progress.touch()
              },
              onStoryComplete: () => {
                progress.completeStory()
              },
              onCapturesDrained: () => {
                logBuildMemoryUsage("capture-drain", screenshotTest.id)
              },
            },
          })

          // Wrap the render fan-out in the build watchdog. Two triggers share one abort path
          // (issue #452): the progress watchdog fires when no story has completed for
          // WORKER_PROGRESS_TIMEOUT_MS (a wedged build is detected in minutes regardless of
          // size), and the derived ceiling above is the whole-build backstop. On either trigger
          // we force-close every pooled session so the in-flight WebDriver commands reject and
          // the stack unwinds. Crucially, withTimeout then waits for the fan-out to actually
          // settle before surfacing the error — the per-story `finally` that returns each
          // session to the pool must run before the worker is freed to accept a new build. If
          // the render fails to unwind within the grace period, a session is wedged beyond
          // in-process recovery, so withTimeout exits the worker (default onUnrecoverable) and
          // the orchestrator restarts a clean process. BuildTimeoutError (and its subclass
          // BuildStalledError) is treated as a non-retryable failure by the task scheduler.
          testResults = await withTimeout(
            renderAllStories,
            buildTimeoutMs,
            () => {
              log.warn(
                `Build ${screenshotTest.id} (#${screenshotTest.buildNumber}) hit the build watchdog ` +
                  `(ceiling ${buildTimeoutMs}ms, ${progress.completedStories}/${storyCount} stories ` +
                  `completed); aborting and closing browser session(s)`,
              )
              // Force-close every pooled session so in-flight WebDriver commands reject.
              return pool.destroyAll()
            },
            {
              abortGraceMs: BUILD_ABORT_GRACE_MS,
              onUnrecoverable: (err) => {
                log.fatal(
                  err,
                  `Build ${screenshotTest.id} (#${screenshotTest.buildNumber}) did not unwind within ` +
                    `${BUILD_ABORT_GRACE_MS}ms after abort; a render is wedged. Exiting worker so the ` +
                    `orchestrator restarts a clean process.`,
                )
                // Before exiting, best-effort fail the build and post the failed VCS status
                // (issue #451) so CI is unblocked immediately instead of waiting for the
                // stuck-build sweeper. Bounded by WORKER_FATAL_FAILSAFE_TIMEOUT_MS so a slow
                // database or VCS API cannot stall the restart; process.exit(1) runs regardless.
                void (async () => {
                  try {
                    await Promise.race([
                      failBuildBeforeExit(screenshotTestId, taskQueueId, screenshotTest, {
                        githubCheckData,
                        gitlabCheckData,
                      }),
                      new Promise<void>((resolve) => {
                        setTimeout(resolve, WORKER_FATAL_FAILSAFE_TIMEOUT_MS).unref()
                      }),
                    ])
                  } catch (failErr) {
                    log.error(
                      failErr,
                      `Failed to fail build ${screenshotTest.id} before fatal exit`,
                    )
                  } finally {
                    process.exit(1)
                  }
                })()
              },
              // The progress watchdog; 0 disables it, leaving only the ceiling.
              ...(WORKER_PROGRESS_TIMEOUT_MS > 0
                ? {
                    stall: {
                      getLastProgressMs: () => progress.lastProgressAtMs,
                      stallTimeoutMs: WORKER_PROGRESS_TIMEOUT_MS,
                    },
                  }
                : {}),
            },
          )
        } finally {
          endBuildProgress()
        }
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

        // Update VCS status with the build results
        if (githubCheckData) {
          await updateGitHubCheckRunWithBuildResults(
            githubCheckData,
            screenshotTest,
            testResults,
            changeCount,
          )
        } else if (gitlabCheckData && gitlabConfigured && gitlabHost) {
          const hasChanges = changeCount > 0
          if (!hasChanges) {
            // Only update status to success if no changes - otherwise stay in pending until approved
            await updateGitLabCommitStatus({
              ...gitlabCheckData,
              gitlabHost,
              state: "success",
              testId: screenshotTest.id,
              name: gitlabStatusContext(screenshotTest.project.key),
              description: "No visual changes detected",
            })
          } else {
            log.info(
              `GitLab status staying in pending for ${changeCount} unapproved change(s) - approval will set success`,
            )
          }
        }
      } finally {
        log.debug("Shutting down local server")
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    try {
      // The render phase. Story discovery runs first under its own per-step timeouts; the
      // concurrent render fan-out inside is guarded by the build watchdog (progress stall +
      // derived whole-build ceiling, issue #452).
      await renderStorybook()
      recordBuildOutcome("completed", (Date.now() - ingestStartMs) / 1000)
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

    // If status is still "running", something went wrong without throwing an error
    if (screenshotTest.status === "running") {
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
      `Storybook ingestion completed for ${screenshotTest.id} (build #${screenshotTest.buildNumber}) with status: ${screenshotTest.status}`,
    )
  }
}

async function updateGitHubCheckRunWithBuildResults(
  githubCheckData: GitHubCheckData,
  screenshotTest: ScreenshotTest,
  testResults: TestResult[],
  changeCount: number,
): Promise<void> {
  const hasChanges = changeCount > 0

  try {
    // Update GitHub check run "Visual Tests" with the build results
    const resolveImageUrl = await buildImageUrlResolver(testResults)
    const { title, summary, text } = createMarkdownForBuildResult(
      screenshotTest,
      testResults,
      resolveImageUrl,
    )
    await updateGitHubCheckRun({
      owner: githubCheckData.owner,
      repo: githubCheckData.repo,
      installationId: githubCheckData.installationId,
      checkRunId: githubCheckData.checkRunId,
      testId: screenshotTest.id,
      status: hasChanges ? "queued" : "completed",
      conclusion: hasChanges ? "action_required" : "success",
      title,
      summary,
      text,
      // Unfortunately, GitHub does not support actions for check runs that are queued
      // actions: hasChanges
      //   ? [
      //       {
      //         label: "✅ Approve",
      //         description: `Approve ${changeCount} visual change${changeCount === 1 ? "" : "s"}`,
      //         identifier: "approved",
      //       },
      //       {
      //         label: "❌ Deny",
      //         description: `Deny ${changeCount} visual change${changeCount === 1 ? "" : "s"}`,
      //         identifier: "denied",
      //       },
      //     ]
      //   : undefined,
    })
  } catch (error) {
    log.error(error, "Failed to update GitHub check run to completed")
    // Continue even if the GitHub API calls fail
  }
}

async function getS3BucketForProjectId(_projectId: string): Promise<string> {
  return S3_BUCKET_NAME
}
