import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"
import type { Capabilities } from "@wdio/types"
import { promises as fsPromises } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import {
  ScreenshotTest,
  TestResult,
  createMarkdownForBuildResult,
  gitlabStatusContext,
  uploadTarballKey,
  type TestResultErrorKind,
} from "shared"
import type { Repository } from "typeorm"
import { remote } from "webdriverio"

import { createBrowserPool, type BrowserPool } from "./browserPool"
import { Database, DatabasePool } from "./database"
import { downloadWithTimeout } from "./download"
import {
  BUILD_ABORT_GRACE_MS,
  BUILD_MEMORY_WARN_BYTES,
  BUILD_TIMEOUT_FLOOR_MS,
  BUILD_TIMEOUT_MS,
  CHROMEDRIVER_PORT,
  S3_BUCKET_NAME,
  S3_CLIENT_CONFIG,
  WORKER_CHROME_EXTRA_ARGS,
  WORKER_EGRESS_BLOCK_MODE,
  WORKER_ENABLE_WEBGL,
  WORKER_FATAL_FAILSAFE_TIMEOUT_MS,
  WORKER_FINALIZE_CONCURRENCY,
  WORKER_FINALIZE_QUEUE_LIMIT,
  WORKER_MAX_TASK_ATTEMPTS,
  WORKER_PER_STORY_BUDGET_MS,
  WORKER_PROGRESS_TIMEOUT_MS,
  WORKER_SESSION_MAX_INFRA_FAILURES,
  WORKER_SESSION_RECYCLE_STORIES,
  WORKER_STORY_CONCURRENCY,
} from "./environment"
import { safeExtract } from "./extract"
import { updateGitHubCheckRun, type GitHubCheckData } from "./github"
import { getGitLabHostConfig, updateGitLabCommitStatus, type GitLabCheckData } from "./gitlab"
import { log } from "./log"
import { recordStoryPhaseDuration, recordStoryResult } from "./metrics"
import { runStoryPipeline, settlePrewarmedPool } from "./pipeline"
import { beginBuildProgress, endBuildProgress } from "./progress"
import { buildImageUrlResolver } from "./s3"
import {
  hardenedChromeArgs,
  installBrowserSafeguards,
  installNetworkEgressBlock,
} from "./safeguards"
import { startStaticServer } from "./server"
import { installSessionDiagnostics } from "./sessionDiagnostics"
import {
  captureStoryWithRetry,
  finalizeStoryWithRecording,
  getStorybookStories,
  navigateToStorybook,
} from "./stories"
import { installStoryRenderStateHook } from "./storyReady"
import { NonRetryableTaskError, isPermanentS3FetchError, normalizeTaskDataId } from "./tasks"
import { BuildTimeoutError, withTimeout } from "./timeout"
import type { Story } from "./types"
import { parseBuildCheckData, type BuildCheckData } from "./vcsStatus"
import { nodeCompatTransformRequest } from "./wdio"

/**
 * Cross-worker build sharding (issue #456, Phase B).
 *
 * One large build is divided across worker replicas: the discovery (`ingest_storybook`) task
 * enumerates the storybook's stories, records `screenshot_tests.expected_story_count`, and
 * enqueues `render_story_chunk` tasks — one per chunk of story ids. Any worker claims chunks
 * (oldest-first SKIP LOCKED, see tasks.ts); each chunk downloads/reuses the extracted tarball,
 * renders only its story ids, and upserts TestResult rows keyed on the unique
 * (screenshot_test_id, story_id) index. The last-finishing chunk wins the completion reconcile
 * (a conditional UPDATE guarded on `status = 'running'`) and posts the final VCS status. A
 * browser crash or watchdog abort now costs one chunk, not the whole build.
 *
 * This module also owns the render internals shared by the inline (unsharded) ingest path and
 * the per-chunk path, so the two stay behaviorally identical: browser-pool construction, tarball
 * download/extract, baseline prefetch, and the watchdog-guarded render fan-out.
 */

/** Log resident set size, warning when it crosses the configured threshold. */
export function logBuildMemoryUsage(phase: string, screenshotTestId: number): void {
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
 * stall detector. On the sharded path the ceiling is derived per chunk from the chunk's story
 * count, so blast radius and timeout scale together.
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

export async function getS3BucketForProjectId(_projectId: string): Promise<string> {
  return S3_BUCKET_NAME
}

// --- Chunk planning and enqueueing --------------------------------------------------------------

/**
 * Partition `storyIds` into render chunks of `chunkSize` (the last chunk may be short). Order is
 * stable: chunk `i` holds ids `[i*size, (i+1)*size)` of the input, and every id appears exactly
 * once across the returned chunks.
 */
export function planChunks(storyIds: readonly string[], chunkSize: number): string[][] {
  const size = Math.max(1, Math.floor(chunkSize) || 1)
  const chunks: string[][] = []
  for (let i = 0; i < storyIds.length; i += size) {
    chunks.push(storyIds.slice(i, i + size))
  }
  return chunks
}

/**
 * The `data` jsonb payload of a `render_story_chunk` task. `githubCheckData` / `gitlabCheckData`
 * reuse the exact shapes the api stores on the `ingest_storybook` task, so every chunk can post
 * VCS statuses (only the completion winner actually does).
 */
export interface RenderChunkPayload {
  projectId: string
  uploadId: string
  storyIds: string[]
  chunkIndex: number
  chunkCount: number
  githubCheckData?: GitHubCheckData
  gitlabCheckData?: GitLabCheckData
}

/**
 * Narrow an unknown task `data` jsonb to a {@link RenderChunkPayload}, or undefined.
 *
 * `projectId`/`uploadId` accept numbers as well as strings (normalized via normalizeTaskDataId):
 * the api's `Project.id` is a NUMBER (`@PrimaryGeneratedColumn`) stored unquoted in jsonb, and a
 * payload that copied it verbatim must parse — rejecting it would (and, pre-fix, did) delete
 * every chunk task as non-retryable and strand the build in "running" until the sweeper failed
 * it. Only null/undefined/empty ids are rejected.
 */
export function parseRenderChunkPayload(data: unknown): RenderChunkPayload | undefined {
  if (typeof data !== "object" || data == null) {
    return undefined
  }
  const obj = data as Record<string, unknown>
  const { chunkIndex, chunkCount, storyIds } = obj
  const projectId = normalizeTaskDataId(obj.projectId)
  const uploadId = normalizeTaskDataId(obj.uploadId)
  if (projectId == undefined || uploadId == undefined) {
    return undefined
  }
  if (
    !Array.isArray(storyIds) ||
    storyIds.length === 0 ||
    !storyIds.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    return undefined
  }
  if (typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return undefined
  }
  if (typeof chunkCount !== "number" || !Number.isInteger(chunkCount) || chunkCount < 1) {
    return undefined
  }
  // parseBuildCheckData validates the stored VCS check-data shapes (and normalizes
  // bigint-backed ids that jsonb round-trips as strings).
  const checkData = parseBuildCheckData(data)
  return {
    projectId,
    uploadId,
    storyIds,
    chunkIndex,
    chunkCount,
    githubCheckData: checkData?.githubCheckData,
    gitlabCheckData: checkData?.gitlabCheckData,
  }
}

/**
 * Batch-insert one `render_story_chunk` task per chunk. A single multi-row INSERT keeps the
 * enqueue atomic (either every chunk exists or none do). The task_queue insert trigger fires a
 * pg_notify per row; workers that are busy simply ignore the extra wake-ups.
 */
export async function enqueueRenderChunks(
  screenshotTest: ScreenshotTest,
  // string | number so a caller holding the api's numeric Project.id cannot enqueue a numeric
  // id: the chunk jsonb must always carry string ids (parseRenderChunkPayload tolerates numbers
  // for rows enqueued pre-fix, but new rows are normalized at the source).
  projectId: string | number,
  uploadId: string,
  chunks: readonly (readonly string[])[],
  checkData?: BuildCheckData,
): Promise<void> {
  if (chunks.length === 0) {
    throw new Error("enqueueRenderChunks called with no chunks")
  }
  const values: string[] = []
  const params: unknown[] = []
  chunks.forEach((storyIds, chunkIndex) => {
    const data: RenderChunkPayload = {
      projectId: String(projectId),
      uploadId,
      storyIds: [...storyIds],
      chunkIndex,
      chunkCount: chunks.length,
      githubCheckData: checkData?.githubCheckData,
      gitlabCheckData: checkData?.gitlabCheckData,
    }
    // JSON.stringify drops undefined check-data keys, matching how the api stores the ingest
    // task's jsonb payload.
    params.push(screenshotTest.id, JSON.stringify(data))
    values.push(`($${params.length - 1}, 'render_story_chunk', $${params.length}::jsonb)`)
  })
  const client = await DatabasePool()
  try {
    await client.query(
      `INSERT INTO task_queue (screenshot_test_id, task_type, data) VALUES ${values.join(", ")}`,
      params,
    )
  } finally {
    client.release()
  }
  log.info(
    `Enqueued ${chunks.length} render_story_chunk task(s) for build ${screenshotTest.id} ` +
      `(#${screenshotTest.buildNumber})`,
  )
}

// --- Build completion reconcile -----------------------------------------------------------------

export type ReconcileResult =
  | { outcome: "won"; status: "unapproved" | "no_changes" }
  | { outcome: "not_ready" }
  | { outcome: "already_done" }

/**
 * Single-statement completion reconcile: once every expected story has a TestResult row, flip
 * the build out of `running` and record its change count/duration. The `status = 'running'`
 * guard makes exactly one concurrent caller win the flip (Postgres row-locks the build row and
 * the loser re-evaluates the predicate after the winner commits), so only the winner posts the
 * final VCS status. `failed` results count as changes, matching the inline path's aggregation.
 */
const RECONCILE_SQL = `
  WITH agg AS (
    SELECT count(DISTINCT story_id) AS done,
           count(DISTINCT story_id) FILTER (WHERE change_status <> 'unchanged') AS changes
    FROM test_results
    WHERE screenshot_test_id = $1)
  UPDATE screenshot_tests st
  SET status = CASE WHEN agg.changes > 0 THEN 'unapproved' ELSE 'no_changes' END,
      total_changes = agg.changes,
      build_duration_sec = EXTRACT(EPOCH FROM (NOW() - st.created_at))::int,
      updated_at = NOW()
  FROM agg
  WHERE st.id = $1
    AND st.status = 'running'
    AND st.expected_story_count IS NOT NULL
    AND agg.done >= st.expected_story_count
  RETURNING st.status`

/**
 * Attempt to complete the build (issue #456, Phase B). Returns:
 *
 *  - `won`: this caller's UPDATE flipped the build out of `running` — it must post the final
 *    VCS status (see {@link completeBuild}). Carries the final status for that post.
 *  - `not_ready`: the build is still `running` with fewer distinct story results than
 *    `expected_story_count` (other chunks are still rendering).
 *  - `already_done`: the build is no longer `running` — a concurrent reconcile won, the build
 *    was failed/swept, or the row is gone.
 */
export async function reconcileBuildCompletion(screenshotTestId: number): Promise<ReconcileResult> {
  const client = await DatabasePool()
  try {
    const res = await client.query(RECONCILE_SQL, [screenshotTestId])
    if ((res.rowCount ?? 0) > 0) {
      const status = (res.rows[0] as { status: string }).status
      return { outcome: "won", status: status === "unapproved" ? "unapproved" : "no_changes" }
    }
    // Disambiguate the 0-row case: still running (counts short) vs already terminal.
    const check = await client.query(`SELECT status FROM screenshot_tests WHERE id = $1`, [
      screenshotTestId,
    ])
    if ((check.rowCount ?? 0) === 0) {
      log.warn(`Cannot reconcile build ${screenshotTestId}: screenshot test row not found`)
      return { outcome: "already_done" }
    }
    const status = (check.rows[0] as { status: string }).status
    return status === "running" ? { outcome: "not_ready" } : { outcome: "already_done" }
  } finally {
    client.release()
  }
}

/**
 * Post the final build-result VCS status (GitHub rich-markdown check run, or GitLab commit
 * status), loading the build's TestResults from the database so the inline and sharded
 * completion paths share one implementation. No-op without check data.
 */
export async function completeBuild(
  screenshotTest: ScreenshotTest,
  checkData: BuildCheckData | undefined,
): Promise<void> {
  const githubCheckData = checkData?.githubCheckData
  const gitlabCheckData = checkData?.gitlabCheckData
  if (!githubCheckData && !gitlabCheckData) {
    return
  }

  const db = await Database()
  const testResults = await db.getRepository(TestResult).find({
    where: { screenshotTest: { id: screenshotTest.id } },
    order: { storyId: "ASC" },
  })
  const changeCount = testResults.filter((result) => result.changeStatus !== "unchanged").length

  if (githubCheckData) {
    await updateGitHubCheckRunWithBuildResults(
      githubCheckData,
      screenshotTest,
      testResults,
      changeCount,
    )
    return
  }

  if (gitlabCheckData) {
    const gitlabHost = screenshotTest.project.gitlabHost ?? gitlabCheckData.gitlabHost
    if (!getGitLabHostConfig(gitlabHost)) {
      log.warn(
        { projectId: screenshotTest.project.id, gitlabHost },
        "Skipping GitLab commit status update: no service token configured for host",
      )
      return
    }
    if (changeCount === 0) {
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
    })
  } catch (error) {
    log.error(error, "Failed to update GitHub check run to completed")
    // Continue even if the GitHub API calls fail
  }
}

/**
 * Reconcile and, when this caller wins the completion flip, post the final VCS status. The
 * local entity's status/changes are updated so the markdown helpers render the final state.
 */
export async function reconcileAndComplete(
  screenshotTest: ScreenshotTest,
  checkData?: BuildCheckData,
): Promise<ReconcileResult> {
  const result = await reconcileBuildCompletion(screenshotTest.id)
  if (result.outcome === "won") {
    log.info(
      `Build ${screenshotTest.id} (#${screenshotTest.buildNumber}) completed across shards ` +
        `with status "${result.status}"`,
    )
    screenshotTest.status = result.status
    await completeBuild(screenshotTest, checkData)
  }
  return result
}

// --- Chunk failure recording --------------------------------------------------------------------

/**
 * Upsert a `failed` TestResult for every listed story that does not already have a result row
 * for this build (`ON CONFLICT DO NOTHING` keeps rows from earlier successful attempts). Used
 * for stories that vanished between discovery and the chunk's extract, chunk watchdog aborts,
 * and the chunk give-up path — keeping the per-build result counts convergent so
 * {@link reconcileBuildCompletion} can still complete the build.
 */
export async function recordChunkStoryFailures(
  screenshotTestId: number,
  storyIds: readonly string[],
  errorKind: TestResultErrorKind,
  errorMessage: string,
): Promise<void> {
  if (storyIds.length === 0) {
    return
  }
  const client = await DatabasePool()
  try {
    const res = await client.query(
      `INSERT INTO test_results
         (screenshot_test_id, story_id, name, new_image_url, change_status, error_kind, error_message)
       SELECT $1, sid, sid, '', 'failed', $3, $4
       FROM unnest($2::text[]) AS sid
       ON CONFLICT (screenshot_test_id, story_id) DO NOTHING`,
      [screenshotTestId, [...storyIds], errorKind, errorMessage],
    )
    if ((res.rowCount ?? 0) > 0) {
      log.warn(
        `Recorded ${res.rowCount} failed test result(s) for build ${screenshotTestId} ` +
          `(${errorKind}): ${errorMessage}`,
      )
    }
  } finally {
    client.release()
  }
}

/**
 * Permanently give up on a `render_story_chunk` task that has exhausted its retry budget
 * (issue #456, Phase B): record failed TestResults for the chunk's stories that never produced
 * one, then reconcile — completing the build with partial failures instead of killing it. The
 * counterpart of worker.ts giveUpOnTask()'s build-failing path for ingest tasks; a single bad
 * chunk must not fail the other chunks' work.
 */
export async function giveUpOnChunkTask(screenshotTestId: number, data: unknown): Promise<void> {
  const payload = parseRenderChunkPayload(data)
  if (!payload) {
    log.error(
      `Cannot give up on chunk task for build ${screenshotTestId} cleanly: invalid payload ` +
        JSON.stringify(data),
    )
    return
  }
  log.warn(
    `Giving up on chunk ${payload.chunkIndex + 1}/${payload.chunkCount} for build ` +
      `${screenshotTestId}: recording failed results for its stories and reconciling`,
  )
  await recordChunkStoryFailures(
    screenshotTestId,
    payload.storyIds,
    "unknown",
    `Render chunk ${payload.chunkIndex + 1}/${payload.chunkCount} failed permanently after ` +
      `exhausting its retry budget`,
  )
  const outcome = await reconcileBuildCompletion(screenshotTestId)
  if (outcome.outcome !== "won") {
    return
  }
  // This give-up completed the build: post the final VCS status (best effort — the entity is
  // only needed for the status post, so it is loaded lazily and only when check data exists).
  const checkData = parseBuildCheckData(payload)
  if (!checkData) {
    return
  }
  const db = await Database()
  const screenshotTest = await db.getRepository(ScreenshotTest).findOneBy({ id: screenshotTestId })
  if (screenshotTest) {
    screenshotTest.status = outcome.status
    await completeBuild(screenshotTest, checkData)
  }
}

// --- Browser pool construction (shared by ingest + chunk paths) ---------------------------------

/** Build the WebdriverIO config for a headless screenshot session. */
function buildWdioConfig(outputDir: string): Capabilities.WebdriverIOConfig {
  return {
    outputDir: path.join(outputDir, "wdio-logs"),
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
          {
            enableWebgl: WORKER_ENABLE_WEBGL,
            // "resolver" (the default) blocks off-origin egress at the DNS layer for every
            // context — the fix for the #473 interception wedge. chromedriver launches a
            // fresh Chrome per session from these args, so the rules apply per session.
            egressBlockMode: WORKER_EGRESS_BLOCK_MODE,
            extraArgs: WORKER_CHROME_EXTRA_ARGS,
          },
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
}

/**
 * Build a pool of independent headless-Chrome sessions so stories render concurrently (issue
 * #152, Phase 1b). Pool size == WORKER_STORY_CONCURRENCY (default 1). Each session gets the
 * page-level safeguards installed up front (disable real-time transports + off-origin
 * fetch/XHR/window.open at the JS layer) before it navigates to any untrusted story; the hard
 * network egress boundary is installed per session by the caller, once the static-server origin
 * is known. Sessions are recycled after WORKER_SESSION_RECYCLE_STORIES stories (bounding
 * Chrome's cumulative memory growth, issue #453) and replaced after
 * WORKER_SESSION_MAX_INFRA_FAILURES consecutive infra failures (dead-session recovery, issue
 * #450).
 *
 * Prewarm (issue #456): callers kick this off BEFORE the tarball download so all N Chrome
 * sessions launch concurrently with the download + extraction; `settlePrewarmedPool` joins the
 * two so an early failure never leaks Chrome processes.
 */
export function createStoryBrowserPool(outputDir: string): Promise<BrowserPool> {
  const config = buildWdioConfig(outputDir)
  return createBrowserPool(
    WORKER_STORY_CONCURRENCY,
    async () => {
      const session = await remote(config)
      await installBrowserSafeguards(session)
      // Record Storybook's story-render lifecycle in the page (issue #458) so capture waits for
      // render completion instead of screenshotting an async story's loading fallback.
      await installStoryRenderStateHook(session)
      // Buffer console output and in-flight network requests per session (issue #475) so a
      // failed story's TestResult carries actionable troubleshooting context. Runs in this
      // factory so pool.replace()'s fresh browsers are covered too.
      await installSessionDiagnostics(session)
      return session
    },
    {
      recycleAfterStories: WORKER_SESSION_RECYCLE_STORIES,
      maxConsecutiveInfraFailures: WORKER_SESSION_MAX_INFRA_FAILURES,
    },
  )
}

// --- Tarball download/extract + per-upload cache ------------------------------------------------

/**
 * Download the uploaded storybook tarball from S3 into `destDir` and safely extract it there.
 * A permanently-missing tarball (e.g. NoSuchKey) surfaces as NonRetryableTaskError so the
 * worker deletes the task from the queue instead of releasing the lock for backoff retries.
 * Returns the downloaded tarball's path (callers may delete it after extraction).
 */
export async function downloadAndExtractTarball(opts: {
  s3Client: S3Client
  bucket: string
  key: string
  destDir: string
}): Promise<string> {
  const { s3Client, bucket, key, destDir } = opts
  const tarballPath = path.join(destDir, "storybook.tar.gz")
  log.info(`Downloading storybook build from S3 ${key} -> ${tarballPath}`)
  const getObjectCommand = new GetObjectCommand({ Bucket: bucket, Key: key })
  let response
  try {
    response = await s3Client.send(getObjectCommand)
  } catch (error) {
    // If the upload tarball is permanently gone (e.g. NoSuchKey) there is no point retrying.
    // Surface it as a non-retryable error so the worker deletes the task from the queue instead
    // of releasing the lock for backoff retries.
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
  log.info(`Extracting storybook build to: ${destDir}`)
  await safeExtract(tarballPath, destDir)
  log.debug(`Successfully extracted storybook build`)
  return tarballPath
}

const UPLOAD_CACHE_PREFIX = "vizdiff-upload-"
const UPLOAD_CACHE_MARKER_FILE = ".vizdiff-extract-complete"

/**
 * How long an extracted-tarball cache dir survives without being (re)used. Long enough for
 * every chunk of one build to hit the cache; short enough that dead uploads don't accumulate
 * on disk. The marker file's mtime is refreshed on every cache hit.
 */
export const UPLOAD_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/** The per-upload extracted-tarball cache directory for chunk tasks. */
export function uploadCacheDir(uploadId: string): string {
  // uploadId flows into a filesystem path; reject anything that isn't a simple token.
  if (!/^[A-Za-z0-9._-]+$/.test(uploadId) || uploadId.startsWith(".")) {
    throw new NonRetryableTaskError(`Invalid uploadId for cache dir: ${JSON.stringify(uploadId)}`)
  }
  return path.join(os.tmpdir(), `${UPLOAD_CACHE_PREFIX}${uploadId}`)
}

/**
 * Remove per-upload cache dirs whose newest activity (dir mtime or marker mtime — the marker is
 * touched on every cache hit) is older than the TTL. Run at chunk start; best-effort.
 */
export async function sweepStaleUploadCaches(ttlMs: number = UPLOAD_CACHE_TTL_MS): Promise<void> {
  let entries: string[]
  try {
    entries = await fsPromises.readdir(os.tmpdir())
  } catch (err) {
    log.debug(err, "Failed to list tmpdir for upload-cache sweep")
    return
  }
  const cutoffMs = Date.now() - ttlMs
  for (const entry of entries) {
    if (!entry.startsWith(UPLOAD_CACHE_PREFIX)) {
      continue
    }
    const dir = path.join(os.tmpdir(), entry)
    try {
      const dirStat = await fsPromises.stat(dir)
      let newestMs = dirStat.mtimeMs
      try {
        const markerStat = await fsPromises.stat(path.join(dir, UPLOAD_CACHE_MARKER_FILE))
        newestMs = Math.max(newestMs, markerStat.mtimeMs)
      } catch {
        // No marker (incomplete extract): the dir mtime alone decides.
      }
      if (newestMs < cutoffMs) {
        log.info(`Removing stale extracted-upload cache ${dir}`)
        await fsPromises.rm(dir, { recursive: true, force: true })
      }
    } catch (err) {
      log.debug(err, `Failed to sweep upload cache entry ${dir}`)
    }
  }
}

/**
 * Ensure the upload's tarball is extracted under the per-upload cache dir, downloading and
 * extracting it only when no complete cached copy exists. The marker file is written only after
 * a successful extract (so a crash mid-extract is re-downloaded, not trusted) and touched on
 * every hit so an active build keeps its cache alive across the TTL sweep.
 */
export async function ensureUploadExtracted(
  s3Client: S3Client,
  bucket: string,
  projectId: string,
  uploadId: string,
): Promise<string> {
  const dir = uploadCacheDir(uploadId)
  const markerPath = path.join(dir, UPLOAD_CACHE_MARKER_FILE)
  try {
    await fsPromises.access(markerPath)
    const now = new Date()
    await fsPromises.utimes(markerPath, now, now)
    log.info(`Using cached extracted storybook for upload ${uploadId}: ${dir}`)
    return dir
  } catch {
    // Cache miss (or incomplete previous extract): rebuild the dir from scratch.
  }
  await fsPromises.rm(dir, { recursive: true, force: true })
  await fsPromises.mkdir(dir, { recursive: true })
  const key = uploadTarballKey(projectId, uploadId)
  const tarballPath = await downloadAndExtractTarball({ s3Client, bucket, key, destDir: dir })
  // The extracted files are what later chunks need; drop the tarball to halve the disk cost.
  await fsPromises.rm(tarballPath, { force: true })
  await fsPromises.writeFile(markerPath, "")
  return dir
}

// --- Baseline prefetch (shared by ingest + chunk paths) -----------------------------------------

/**
 * Fetch the baseline TestResults for the build's base commit, keyed by story id. Empty when the
 * build has no base commit. `storyIds` (the chunk path) restricts the fetch to the given
 * stories; the inline path omits it and prefetches every baseline row.
 */
export async function fetchBaseTestResults(
  screenshotTest: ScreenshotTest,
  storyIds?: readonly string[],
): Promise<Map<string, TestResult>> {
  const baseTestResults = new Map<string, TestResult>()
  if (!screenshotTest.baseCommitSha) {
    return baseTestResults
  }
  log.info(`Fetching base test results for commit ${screenshotTest.baseCommitSha}`)
  const db = await Database()
  let query = db
    .getRepository(TestResult)
    .createQueryBuilder("result")
    .leftJoinAndSelect("result.screenshotTest", "test")
    // Filter by project as well as commit sha: two projects can share a commit sha
    // (forks, monorepos), and the pair lets Postgres use the
    // (project_id, commit_sha) index.
    .where("test.project_id = :projectId", { projectId: screenshotTest.project.id })
    .andWhere("test.commit_sha = :commitSha", { commitSha: screenshotTest.baseCommitSha })
  if (storyIds != undefined && storyIds.length > 0) {
    query = query.andWhere("result.story_id IN (:...storyIds)", { storyIds: [...storyIds] })
  }
  const baseTests = await query.getMany()
  for (const test of baseTests) {
    baseTestResults.set(test.storyId, test)
  }
  log.info(`Found ${baseTestResults.size} base test results`)
  return baseTestResults
}

// --- Watchdog-guarded render fan-out (shared by ingest + chunk paths) ---------------------------

export interface RenderStoriesParams {
  pool: BrowserPool
  stories: readonly Story[]
  screenshotTest: ScreenshotTest
  baseTestResults: ReadonlyMap<string, TestResult>
  bucket: string
  /** Scratch dir for screenshots/stabilization files (NOT necessarily the storybook dir). */
  tmpDir: string
  projectId: string
  uploadId: string
  port: number
  s3Client: S3Client
  testResultTable: Repository<TestResult>
  /**
   * Best-effort cleanup raced against WORKER_FATAL_FAILSAFE_TIMEOUT_MS just before the fatal
   * `process.exit(1)` when a wedged render fails to unwind after the watchdog abort (issue
   * #451). The inline path fails the build + posts the failed VCS status; the chunk path only
   * releases its task lock so another worker retries the chunk (blast radius: one chunk).
   */
  fatalCleanup?: () => Promise<void>
}

/**
 * Render stories concurrently across the session pool (issue #152, Phase 1b) through the
 * two-lane capture/finalize pipeline (issue #456), guarded by the build watchdog (issue #452).
 * Capture slots equal the pool size, so a slot rarely waits on acquire(); on capture success
 * the session is released immediately and the story's S3 uploads + baseline diff + DB save run
 * in a bounded background lane (WORKER_FINALIZE_CONCURRENCY), letting the session move straight
 * to the next story. WORKER_FINALIZE_QUEUE_LIMIT caps captured-but-unfinalized stories (each
 * buffers one PNG in memory). Session checkout, health probing, infra-error retry, and failure
 * recording live inside captureStoryWithRetry/finalizeStoryWithRecording (issues #450/#454): a
 * single story's failure records a `failed` TestResult and resolves, so one bad story (or one
 * dead session) cannot abort the run.
 *
 * Two watchdog triggers share one abort path: the progress watchdog fires when no story has
 * completed for WORKER_PROGRESS_TIMEOUT_MS, and the derived ceiling
 * (computeBuildTimeoutMs(stories, poolSize, BUILD_TIMEOUT_MS)) is the whole-run backstop. On
 * either trigger every pooled session is force-closed so in-flight WebDriver commands reject
 * and the stack unwinds; withTimeout waits for the fan-out to actually settle before surfacing
 * BuildTimeoutError. If the render fails to unwind within the grace period, a session is wedged
 * beyond in-process recovery, so the worker exits (after `fatalCleanup`, bounded by
 * WORKER_FATAL_FAILSAFE_TIMEOUT_MS) and the orchestrator restarts a clean process.
 */
export async function renderStoriesWithWatchdog(
  params: RenderStoriesParams,
): Promise<TestResult[]> {
  const {
    pool,
    stories,
    screenshotTest,
    baseTestResults,
    bucket,
    tmpDir,
    projectId,
    uploadId,
    port,
    s3Client,
    testResultTable,
    fatalCleanup,
  } = params
  const storyCount = stories.length

  // Derive the ceiling from the story count (issue #452): an explicit BUILD_TIMEOUT_MS is used
  // verbatim; otherwise the ceiling scales so a large-but-healthy render is never killed by a
  // flat cap.
  const buildTimeoutMs = computeBuildTimeoutMs(storyCount, pool.size, BUILD_TIMEOUT_MS)
  log.info(
    `Build timeout ceiling: ${buildTimeoutMs}ms for ${storyCount} stories` +
      (WORKER_PROGRESS_TIMEOUT_MS > 0
        ? `, progress watchdog: ${WORKER_PROGRESS_TIMEOUT_MS}ms`
        : ""),
  )
  log.info(
    `Rendering ${storyCount} stories across ${pool.size} session(s) ` +
      `(finalize concurrency ${WORKER_FINALIZE_CONCURRENCY}, ` +
      `queue limit ${WORKER_FINALIZE_QUEUE_LIMIT})`,
  )

  // Track render progress (issue #452): every settled story — success or recorded failure —
  // counts as forward progress. The in-process stall watchdog polls lastProgressAtMs, and a
  // throttled last_progress_at heartbeat lets the cross-worker stuck-build sweeper distinguish
  // a large-but-healthy build from a wedged one (on the sharded path, every chunk feeds the
  // same build-level heartbeat, so the sweeper sees cross-shard progress). Stories count as
  // complete when they FINALIZE; capture completions additionally touch() the watchdog (cheap)
  // so a long finalize backlog is never mistaken for a stall.
  const progress = beginBuildProgress(screenshotTest.id, storyCount)
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
      stories: [...stories],
      captureConcurrency: pool.size,
      finalizeConcurrency: WORKER_FINALIZE_CONCURRENCY,
      queueLimit: WORKER_FINALIZE_QUEUE_LIMIT,
      capture: async (story) => {
        const outcome = await captureStoryWithRetry({ ...storyInfoFor(story), pool })
        // Story metrics (issue #457): a `captured` outcome reports its capture-phase duration
        // (its final ok/failed outcome is recorded at finalize); a `recorded` outcome IS the
        // story's final (failed) result, so record it now.
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

    return await withTimeout(
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
          // Before exiting, run the caller's best-effort cleanup (issue #451) bounded by
          // WORKER_FATAL_FAILSAFE_TIMEOUT_MS so a slow database or VCS API cannot stall the
          // restart; process.exit(1) runs regardless.
          void (async () => {
            try {
              await Promise.race([
                fatalCleanup?.() ?? Promise.resolve(),
                new Promise<void>((resolve) => {
                  setTimeout(resolve, WORKER_FATAL_FAILSAFE_TIMEOUT_MS).unref()
                }),
              ])
            } catch (cleanupErr) {
              log.error(
                cleanupErr,
                `Fatal-exit cleanup failed for build ${screenshotTest.id} before exit`,
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
}

// --- The per-chunk worker path ------------------------------------------------------------------

/** Release a chunk task's claim lock so another worker can retry it promptly. */
async function unlockChunkTask(taskQueueId: number | undefined): Promise<void> {
  if (taskQueueId == undefined) {
    return
  }
  const client = await DatabasePool()
  try {
    await client.query(`UPDATE task_queue SET locked_at = NULL, locked_by = NULL WHERE id = $1`, [
      taskQueueId,
    ])
  } finally {
    client.release()
  }
}

/** Read a task's claim count, or undefined when the row is gone. */
async function getTaskAttempts(taskQueueId: number): Promise<number | undefined> {
  const client = await DatabasePool()
  try {
    const res = await client.query(`SELECT attempts FROM task_queue WHERE id = $1`, [taskQueueId])
    if ((res.rowCount ?? 0) === 0) {
      return undefined
    }
    return (res.rows[0] as { attempts: number }).attempts
  } finally {
    client.release()
  }
}

/**
 * Process one `render_story_chunk` task (issue #456, Phase B): reuse (or download + extract)
 * the upload's tarball, spin up the browser pool and static server, discover the stories, and
 * render ONLY this chunk's story ids through the shared watchdog-guarded fan-out; then attempt
 * the completion reconcile — the last-finishing chunk wins and posts the final VCS status.
 *
 * Failure policy: a chunk-level infra failure throws for task-level retry (attempts backoff via
 * the claim) WITHOUT flipping the build to failed — other chunks keep rendering. A chunk-level
 * watchdog abort (BuildTimeoutError) is terminal for the chunk: its unfinished stories are
 * recorded as failed results and the build reconciles, converging with partial failures. When a
 * chunk's claim count exceeds WORKER_MAX_TASK_ATTEMPTS the chunk gives up the same way (see
 * also giveUpOnChunkTask for the in-process retry-budget path).
 */
export async function runRenderChunk(
  payload: RenderChunkPayload,
  screenshotTestId: number,
  taskQueueId?: number,
): Promise<void> {
  const {
    projectId,
    uploadId,
    storyIds,
    chunkIndex,
    chunkCount,
    githubCheckData,
    gitlabCheckData,
  } = payload
  const checkData: BuildCheckData = { githubCheckData, gitlabCheckData }
  const chunkLabel = `chunk ${chunkIndex + 1}/${chunkCount}`
  log.info(
    `Rendering ${chunkLabel} (${storyIds.length} stories) for build ${screenshotTestId}, ` +
      `upload ${uploadId}`,
  )

  const db = await Database()
  const screenshotTest = await db.getRepository(ScreenshotTest).findOneBy({ id: screenshotTestId })
  if (!screenshotTest) {
    throw new NonRetryableTaskError(`Screenshot test not found: ${screenshotTestId}`)
  }
  // A chunk only renders for a build that is still in flight. Anything else means the build was
  // failed (stuck-build sweeper / give-up) or already completed — drop the chunk quietly (the
  // worker deletes the task row on return).
  if (screenshotTest.status !== "running") {
    log.warn(
      `Skipping ${chunkLabel} for build ${screenshotTestId}: status is ` +
        `"${screenshotTest.status}", not "running"`,
    )
    return
  }

  // Cross-restart retry bound: `attempts` survives worker crashes (in-memory retry budgets do
  // not), so a chunk that reliably kills workers converges instead of crash-looping forever.
  if (taskQueueId != undefined) {
    const attempts = await getTaskAttempts(taskQueueId)
    if (attempts != undefined && attempts > WORKER_MAX_TASK_ATTEMPTS) {
      log.warn(
        `Giving up on ${chunkLabel} for build ${screenshotTestId} after ${attempts} claims ` +
          `(max ${WORKER_MAX_TASK_ATTEMPTS}); recording failed results and reconciling`,
      )
      await recordChunkStoryFailures(
        screenshotTestId,
        storyIds,
        "unknown",
        `Render chunk ${chunkIndex + 1}/${chunkCount} exceeded ${WORKER_MAX_TASK_ATTEMPTS} claim attempts`,
      )
      await reconcileAndComplete(screenshotTest, checkData)
      return
    }
  }

  const s3Client = new S3Client(S3_CLIENT_CONFIG)
  const bucket = await getS3BucketForProjectId(projectId)

  // Per-chunk scratch dir for screenshots/stabilization files. The extracted storybook lives in
  // the shared per-upload cache dir (server below) so sibling chunks skip the download.
  const workDir = path.join(os.tmpdir(), `vizdiff-chunk-${uploadId}-${chunkIndex}-${Date.now()}`)
  await fsPromises.mkdir(workDir, { recursive: true })

  // Prewarm (issue #456): the pool launches concurrently with the (possibly cached) tarball
  // fetch; settlePrewarmedPool tears the pool down if the fetch fails first.
  const poolPromise = createStoryBrowserPool(workDir)
  const ensureExtracted = (async () => {
    await sweepStaleUploadCaches()
    return await ensureUploadExtracted(s3Client, bucket, projectId, uploadId)
  })()

  let pool: BrowserPool
  let storybookDir: string
  try {
    const settled = await settlePrewarmedPool(poolPromise, ensureExtracted)
    pool = settled.pool
    storybookDir = settled.workResult
  } catch (error) {
    await fsPromises.rm(workDir, { recursive: true, force: true })
    throw error
  }

  logBuildMemoryUsage("chunk-render-start", screenshotTestId)
  try {
    // Start a local server to serve the (cached) Storybook files
    const { server, port } = await startStaticServer(storybookDir)
    try {
      // Install the network egress boundary on EVERY pooled session (see ingest.ts): must run
      // before navigating to any untrusted story; replacement sessions get the same boundary
      // via the pool's session-init callback. In the default "resolver" mode this is a no-op
      // (enforcement lives in the Chrome launch args); interception modes install per session.
      const origin = `http://localhost:${port}`
      pool.setSessionInit((browser) =>
        installNetworkEgressBlock(browser, origin, WORKER_EGRESS_BLOCK_MODE),
      )
      await Promise.all(
        pool.sessions.map((session) =>
          installNetworkEgressBlock(session.browser, origin, WORKER_EGRESS_BLOCK_MODE),
        ),
      )

      const primarySession = pool.sessions[0]
      if (!primarySession) {
        throw new Error("Browser pool initialized with no sessions") // unreachable: size >= 1
      }
      const primaryBrowser = primarySession.browser
      await primaryBrowser.setViewport({ width: 1200, height: 900, devicePixelRatio: 1 })

      // Re-discover the stories from the extracted storybook, then FILTER to this chunk's ids.
      await navigateToStorybook(primaryBrowser, port)
      const stories = await getStorybookStories(primaryBrowser)

      const chunkStories: Story[] = []
      const vanishedIds: string[] = []
      for (const id of storyIds) {
        const story = stories[id]
        if (story) {
          chunkStories.push(story)
        } else {
          vanishedIds.push(id)
        }
      }
      if (vanishedIds.length > 0) {
        // A story that was present at discovery but missing from this extract would leave the
        // build's result count short forever; record it failed so the counts stay convergent.
        log.warn(
          `${vanishedIds.length} story id(s) from ${chunkLabel} are missing from the extracted ` +
            `storybook for build ${screenshotTestId}: ${vanishedIds.join(", ")}`,
        )
        await recordChunkStoryFailures(
          screenshotTestId,
          vanishedIds,
          "story-error",
          "Story was present at discovery but vanished from the extracted storybook",
        )
      }

      if (chunkStories.length > 0) {
        // Baseline prefetch, restricted to this chunk's stories.
        const baseTestResults = await fetchBaseTestResults(screenshotTest, storyIds)
        const testResultTable = db.getRepository(TestResult)
        await renderStoriesWithWatchdog({
          pool,
          stories: chunkStories,
          screenshotTest,
          baseTestResults,
          bucket,
          tmpDir: workDir,
          projectId,
          uploadId,
          port,
          s3Client,
          testResultTable,
          // A wedged chunk render exits the worker; before that, release the task lock so
          // another worker retries the chunk promptly. The build is NOT failed — the blast
          // radius of a wedged session is one chunk.
          fatalCleanup: () => unlockChunkTask(taskQueueId),
        })
      }
    } finally {
      log.debug("Shutting down local server")
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  } catch (error) {
    if (error instanceof BuildTimeoutError) {
      // The chunk-level watchdog fired (progress stall or chunk ceiling). Retrying would burn
      // another full window, so the chunk is terminal — but the BUILD is not: record failed
      // results for this chunk's unfinished stories and reconcile so the build still converges
      // (the worker deletes the task row for BuildTimeoutError).
      log.warn(
        error,
        `${chunkLabel} for build ${screenshotTestId} hit the render watchdog; recording failed ` +
          `results for its unfinished stories`,
      )
      try {
        await recordChunkStoryFailures(
          screenshotTestId,
          storyIds,
          "browser-timeout",
          `Render chunk ${chunkIndex + 1}/${chunkCount} hit the render watchdog before this story completed`,
        )
        await reconcileAndComplete(screenshotTest, checkData)
      } catch (recordErr) {
        log.error(
          recordErr,
          `Failed to record watchdog failures for ${chunkLabel} of build ${screenshotTestId}`,
        )
      }
    }
    throw error
  } finally {
    log.debug("Closing WebdriverIO browser session pool")
    // Sessions may already be gone if a timeout abort closed them; destroyAll tolerates that so
    // we never mask the original error with a teardown failure.
    await pool.destroyAll()
    await fsPromises.rm(workDir, { recursive: true, force: true })
    logBuildMemoryUsage("chunk-render-end", screenshotTestId)
  }

  // Every story in this chunk has a TestResult row now. The last-finishing chunk's reconcile
  // wins the status flip and posts the final VCS status; everyone else sees not_ready /
  // already_done.
  const outcome = await reconcileAndComplete(screenshotTest, checkData)
  log.info(`Completed ${chunkLabel} for build ${screenshotTestId} (reconcile: ${outcome.outcome})`)
}
