import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import fs, { promises as fsPromises } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { PNG } from "pngjs"
import {
  diffImageKey,
  ScreenshotTest,
  screenshotKey as buildScreenshotKey,
  TestResult,
  type TestResultStatus,
} from "shared"
import type { Repository } from "typeorm"
import type { Browser } from "webdriverio"

import type { BrowserPool } from "./browserPool"
import {
  MAX_STORY_IDENTIFIER_LENGTH,
  WORKER_CHANGED_MIN_PIXELS,
  WORKER_CHANGED_THRESHOLD,
  WORKER_POST_LOAD_DELAY_MS,
  WORKER_STABILIZE_INTERVAL_MS,
  WORKER_STORY_MAX_ATTEMPTS,
} from "./environment"
import { classifyStoryError, StorageError, type ClassifiedStoryError } from "./errorClassify"
import { diffImages, diffImagesNoMask } from "./images"
import { log } from "./log"
import type { CaptureOutcome } from "./pipeline"
import { probeSession } from "./sessionHealth"
import { waitForStoryReady } from "./storyReady"
import type { SetViewportOptions, Story, StorybookWindow } from "./types"

const SCREENSHOTS_UNCHANGED_TIMEOUT_MS = 10 * 1000
const IMAGE_UNCHANGED_THRESHOLD = 0.001

/**
 * Per-session capture state (issue #474), keyed on the Browser object itself: BrowserPool's
 * `replace()` swaps a brand-new Browser instance into the session, so state cached against the
 * old instance is invalidated automatically (and garbage-collected via the WeakMap). The field
 * set is intentionally minimal for now; a later PR adds navigation state for in-place story
 * switching.
 */
export interface SessionCaptureState {
  /** The viewport last applied via {@link setViewportCached}, for skipping redundant BiDi calls. */
  lastViewport?: SetViewportOptions
}

const sessionCaptureState = new WeakMap<Browser, SessionCaptureState>()

/** Returns the capture state for a browser session, creating it on first use. */
export function getSessionCaptureState(browser: Browser): SessionCaptureState {
  let state = sessionCaptureState.get(browser)
  if (!state) {
    state = {}
    sessionCaptureState.set(browser, state)
  }
  return state
}

/**
 * Viewport skip cache (issue #474): `browser.setViewport` is a BiDi round-trip even when the
 * viewport is unchanged from the previous story — which is the common case, since most stories
 * share the default viewport. Skips the call when the cached last-applied viewport matches, and
 * updates the cache only after a successful call so a failed attempt is retried next time.
 * Discovery-time setViewport calls (ingest/shard) deliberately do not go through this cache.
 */
async function setViewportCached(browser: Browser, viewport: SetViewportOptions): Promise<void> {
  const state = getSessionCaptureState(browser)
  const last = state.lastViewport
  if (
    last?.width === viewport.width &&
    last.height === viewport.height &&
    last.devicePixelRatio === viewport.devicePixelRatio
  ) {
    log.debug(
      `Viewport unchanged (${viewport.width}x${viewport.height}@${viewport.devicePixelRatio}); skipping setViewport`,
    )
    return
  }
  await browser.setViewport(viewport)
  state.lastViewport = { ...viewport }
}

/**
 * Adaptive stabilization cadence (issue #474): how long to sleep before stabilization check
 * `attempt` (1-based). The first check is sleep-free — after semantic readiness (issue #458) most
 * stories are already settled, so the confirmation screenshot is taken ~two animation frames
 * after the first (see {@link waitForTwoAnimationFrames}) instead of after an unconditional
 * 250 ms pause. Only when a diff comes back nonzero (an animation or late layout shift) does the
 * loop fall back to paced sleeps, backing off min(interval, 100) → interval → 2×interval (capped
 * at 500 ms), with SCREENSHOTS_UNCHANGED_TIMEOUT_MS bounding the overall budget.
 */
function stabilizePauseMs(attempt: number): number {
  if (attempt <= 1) {
    return 0
  }
  if (attempt === 2) {
    return Math.min(WORKER_STABILIZE_INTERVAL_MS, 100)
  }
  if (attempt === 3) {
    return WORKER_STABILIZE_INTERVAL_MS
  }
  return Math.min(WORKER_STABILIZE_INTERVAL_MS * 2, 500)
}

/**
 * Waits for two animation frames in the page — i.e. until the browser has had a chance to
 * present a new frame — without any wall-clock sleep. WebdriverIO's BiDi `execute` awaits a
 * returned promise, so this costs one round-trip (~a frame or two) instead of a fixed pause.
 */
async function waitForTwoAnimationFrames(browser: Browser): Promise<void> {
  await browser.execute(async () => {
    // @ts-expect-error: window is not defined
    const w = window as { requestAnimationFrame: (cb: () => void) => void }
    await new Promise<void>((resolve) => {
      w.requestAnimationFrame(() => w.requestAnimationFrame(() => resolve()))
    })
  })
}

export type StoryInfo = {
  story: Story
  screenshotTest: ScreenshotTest
  baseTestResult?: TestResult
  bucket: string
  tmpDir: string
  projectId: string
  uploadId: string
  port: number
  s3Client: S3Client
  testResultTable: Repository<TestResult>
  browser: Browser
}

export async function navigateToStorybook(
  browser: Browser,
  localServerPort: number,
): Promise<void> {
  const timeoutMs = 10 * 1000 // 10 seconds
  const url = `http://localhost:${localServerPort}/iframe.html`
  log.info(`Navigating to Storybook at ${url}`)
  await browser.url(url)
  await browser.waitUntil(
    async () => {
      return await browser.execute(async (): Promise<boolean> => {
        // @ts-expect-error: window is not defined
        // eslint-disable-next-line no-underscore-dangle
        const preview = (window as StorybookWindow).__STORYBOOK_PREVIEW__
        if (!preview?.storyStore) {
          return false
        }

        try {
          await preview.storyStore.cacheAllCSFFiles()
          return true
        } catch {
          return false
        }
      })
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Storybook failed to load stories within ${timeoutMs / 1000}s`,
      interval: 100,
    },
  )
}

/**
 * Extracts a map of story IDs to Story objects from a running Storybook preview.
 * @param browser The WebDriverIO browser instance with a running Storybook preview
 * @returns A map of story IDs to Story objects
 */
export async function getStorybookStories(browser: Browser): Promise<Record<string, Story>> {
  let stories: Record<string, Story> | undefined
  try {
    stories = await browser.execute(async () => {
      // @ts-expect-error: window is not defined
      // eslint-disable-next-line no-underscore-dangle
      const preview = (window as StorybookWindow).__STORYBOOK_PREVIEW__
      if (!preview) {
        return undefined
      }

      try {
        return await preview.extract()
      } catch (err) {
        console.error("Failed to extract stories:", err)
        return undefined
      }
    })
    if (!stories) {
      throw new Error("No stories found in Storybook")
    }
  } catch (err) {
    log.error(err, "Error extracting stories from Storybook")
    throw err
  }

  validateStoryIdentifiers(stories)
  return stories
}

/**
 * Rejects stories whose id/name/title/importPath exceed the configured maximum length. These
 * untrusted strings flow into S3 keys, filesystem paths, database columns, and log lines, so an
 * absurdly long value is treated as a bad upload rather than silently truncated here.
 */
export function validateStoryIdentifiers(
  stories: Record<string, Story>,
  maxLength: number = MAX_STORY_IDENTIFIER_LENGTH,
): void {
  if (maxLength <= 0) {
    return
  }
  for (const [id, story] of Object.entries(stories)) {
    const fields: Array<[string, string | undefined]> = [
      ["id", story.id],
      ["key", id],
      ["name", story.name],
      ["title", story.title],
      ["importPath", story.importPath],
    ]
    for (const [field, value] of fields) {
      if (value != undefined && value.length > maxLength) {
        throw new Error(
          `Story ${field} too long: ${value.length} chars (max ${maxLength}) for story "${id}"`,
        )
      }
    }
  }
}

/**
 * Returns the viewport options for a story, as specified in the story's parameters or the default
 * options if no viewport is specified.
 * @param story The story to get the viewport options for.
 * @returns SetViewportOptions object compatible with WebDriverIO `browser.setViewport`.
 */
export function getStoryViewport(story: Story): SetViewportOptions {
  const DEFAULT_OPTIONS = { width: 1200, height: 900, devicePixelRatio: 1 }
  const MIN_SIZE = 200
  const MAX_SIZE = 2560

  const viewportMap = story.parameters?.viewport?.options ?? story.parameters?.viewport?.viewports
  if (!viewportMap) {
    return DEFAULT_OPTIONS
  }

  const viewportName = story.globals?.viewport?.value ?? story.parameters?.viewport?.defaultViewport
  if (!viewportName) {
    return DEFAULT_OPTIONS
  }

  const viewport = viewportMap[viewportName]
  if (!viewport) {
    return DEFAULT_OPTIONS
  }

  // parseInt("320px") will parse as `320`
  const width = clamp(parseInt(viewport.styles.width), MIN_SIZE, MAX_SIZE) ?? DEFAULT_OPTIONS.width
  const height =
    clamp(parseInt(viewport.styles.height), MIN_SIZE, MAX_SIZE) ?? DEFAULT_OPTIONS.height
  return {
    width,
    height,
    devicePixelRatio: 1,
  }
}

/**
 * Navigates to a story, waits for it to stabilize, and saves a screenshot.
 * Runs against a single browser-pool session, which the caller checks out for the full render of
 * one story, so no additional locking is needed.
 * @param browser WebDriverIO browser instance
 * @param story The story to capture (id + parameters, used for readiness and delay opt-ins)
 * @param port The port where the Storybook is being served locally
 * @param tempDir A temporary directory for stabilization screenshots
 * @param outputFilePath The final path to save the stabilized screenshot
 * @returns The path to the saved screenshot file (same as outputFilePath)
 */
export async function captureStableScreenshot(
  browser: Browser,
  story: Story,
  viewport: SetViewportOptions,
  port: number,
  tempDir: string,
  outputFilePath: string,
): Promise<string> {
  const storyId = story.id
  log.debug(`Capturing stable screenshot for story ${storyId}`)
  const tempPath1 = path.join(tempDir, `${storyId}-temp1.png`)
  const tempPath2 = path.join(tempDir, `${storyId}-temp2.png`)
  let previousScreenshotPath = tempPath1
  let currentScreenshotPath = tempPath2
  let finalScreenshotBuffer: Buffer | undefined

  // Set the initial viewport (skipped when unchanged from the previous story, issue #474)
  log.debug(`Setting initial viewport for ${storyId}: ${viewport.width}x${viewport.height}`)
  await setViewportCached(browser, viewport)

  // Navigate to the story
  const storyUrl = `http://localhost:${port}/iframe.html?id=${storyId}` // Ensure port is used
  log.debug(`Navigating to story URL: ${storyUrl}`)
  await browser.url(storyUrl)

  // Wait for the story's render lifecycle to complete (issue #458). Visual quiescence alone is
  // not enough: async/Suspense stories paint a loading fallback that reads as "stable".
  log.debug(`Waiting for story ${storyId} to render...`)
  const readyResult = await waitForStoryReady(browser, story)

  // Inject CSS to remove Storybook's body padding
  log.debug(`Injecting CSS to remove body padding for story ${storyId}`)
  await browser.execute(() => {
    // @ts-expect-error: document is not defined
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const style = document.createElement("style")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    style.textContent = `
      body.sb-main-padded.sb-show-main {
        padding: 0 !important;
        margin: 0 !important;
      }
    `
    // @ts-expect-error: document is not defined
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    document.head.appendChild(style)
  })

  // Adjust the viewport for the story. This is a best-effort first pass; the layout may not be
  // settled yet, so the post-stabilization adjustment below is authoritative for tall content.
  // The initial measurement rides the readiness snapshot (issue #474) instead of a separate
  // execute round-trip, and is tracked so the post-stabilization re-measure can be skipped when
  // nothing suggested the layout was still moving (issue #456).
  log.debug(`Adjusting viewport for story ${storyId}`)
  const initialContentHeight = readyResult.contentHeight
  let currentViewport: SetViewportOptions = {
    ...viewport,
    height: await adjustViewportForStory(browser, storyId, viewport, initialContentHeight),
  }

  // --- Screenshot Stabilization Logic ---
  log.debug("Taking initial screenshot for stabilization...")
  let previousScreenshotBuffer = await takeScreenshotWithRetry(browser, previousScreenshotPath)
  finalScreenshotBuffer = previousScreenshotBuffer // Initialize screenshot with the first capture

  const startTime = Date.now()
  let stabilized = false
  // Attempts cap derived from the overall budget and the steady-state (post-backoff) pacing, as
  // a backstop for the wall-clock check below (issue #474; the first attempt is sleep-free).
  const MAX_ATTEMPTS =
    1 + Math.ceil(SCREENSHOTS_UNCHANGED_TIMEOUT_MS / Math.max(stabilizePauseMs(4), 1))
  let attempts = 0

  while (attempts < MAX_ATTEMPTS && Date.now() - startTime < SCREENSHOTS_UNCHANGED_TIMEOUT_MS) {
    attempts++
    const pauseMs = stabilizePauseMs(attempts)
    if (pauseMs > 0) {
      await browser.pause(pauseMs)
    } else {
      // Adaptive cadence (issue #474): the first confirmation is rAF-spaced and sleep-free — a
      // settled story stabilizes on this attempt with zero pauses. Backoff sleeps only kick in
      // when this first comparison reports the page still changing.
      await waitForTwoAnimationFrames(browser)
    }
    log.debug(`Taking stabilization screenshot attempt ${attempts}/${MAX_ATTEMPTS}...`)

    let currentScreenshotBuffer: Buffer<ArrayBuffer>
    try {
      currentScreenshotBuffer = await takeScreenshotWithRetry(browser, currentScreenshotPath)
    } catch (err) {
      log.error(
        err,
        `Failed to take screenshot during stabilization attempt ${attempts}. Using previous screenshot.`,
      )
      break // Exit while loop, use the previously captured screenshot
    }

    // Fast path (issue #456): most stories are static, so consecutive captures are usually
    // byte-identical PNGs — and identical bytes are definitionally identical pixels. A buffer
    // compare is far cheaper than two PNG decodes plus a pixelmatch pass.
    let diffRatio: number
    if (previousScreenshotBuffer.equals(currentScreenshotBuffer)) {
      diffRatio = 0
    } else {
      // Compare the previous and current screenshots
      const previousPng = PNG.sync.read(previousScreenshotBuffer)
      const currentPng = PNG.sync.read(currentScreenshotBuffer)

      if (previousPng.width !== currentPng.width || previousPng.height !== currentPng.height) {
        log.error(
          `Screenshot dimensions changed from ${previousPng.width}x${previousPng.height} to ` +
            `${currentPng.width}x${currentPng.height} for story ${storyId}. Continuing stabilization check.`,
        )
        // Update the baseline for the next comparison
        previousScreenshotBuffer = currentScreenshotBuffer
        finalScreenshotBuffer = currentScreenshotBuffer // Update final screenshot candidate
        // Swap paths for next iteration
        ;[previousScreenshotPath, currentScreenshotPath] = [
          currentScreenshotPath,
          previousScreenshotPath,
        ]
        continue // Skip stability check for this iteration
      }

      diffRatio = diffImagesNoMask(previousPng, currentPng)
    }
    log.debug(
      `Stability check for story ${storyId}: diffRatio=${diffRatio} (attempt ${attempts}/${MAX_ATTEMPTS})`,
    )

    // Always update the baseline and final screenshot candidate to the latest capture
    previousScreenshotBuffer = currentScreenshotBuffer
    finalScreenshotBuffer = currentScreenshotBuffer
    // Swap paths for the next potential iteration
    ;[previousScreenshotPath, currentScreenshotPath] = [
      currentScreenshotPath,
      previousScreenshotPath,
    ]

    if (diffRatio < IMAGE_UNCHANGED_THRESHOLD) {
      log.info(
        `Screenshot for story ${storyId} stabilized after ${Date.now() - startTime}ms with diffRatio=${diffRatio} (attempt ${attempts})`,
      )
      stabilized = true
      break // Stable state reached, exit loop
    }

    // Not stable yet, check if we're approaching the timeout
    const timeRemaining = SCREENSHOTS_UNCHANGED_TIMEOUT_MS - (Date.now() - startTime)
    if (timeRemaining < stabilizePauseMs(attempts + 1)) {
      log.warn(`Approaching timeout for story ${storyId} stabilization, using last screenshot`)
      break
    }
  } // End while loop

  // --- Post-Loop Handling ---
  if (!stabilized) {
    log.warn(
      `Screenshot for story ${storyId} did not stabilize within ` +
        `${SCREENSHOTS_UNCHANGED_TIMEOUT_MS}ms (${attempts} attempts). Using last captured screenshot.`,
    )
  }

  // --- Post-Stabilization Viewport Fit ---
  // Now that rendering has settled, re-measure the full content height. The initial adjustment
  // (above) can run before the layout finishes (the root cause of tall "Getting Started" docs
  // pages being vertically cut off), so this authoritative pass grows the viewport to fit the
  // full content if needed. We resize at most once and only when the content has grown *beyond*
  // the current viewport, then re-capture after a short settle. Bounding the resize to a single
  // post-stabilization pass avoids a feedback loop where each resize triggers a relayout that
  // changes the height again.
  //
  // Skip the re-measure when nothing suggested the layout was still moving (issue #456): the
  // very first stability check already found the page settled AND the initially measured
  // content height fit within the story's viewport (no growth was needed, so tall-content
  // correctness is not at stake). A late-settling layout changes pixels between the first two
  // screenshots, which forces extra attempts and keeps the authoritative pass.
  const skipSettledMeasure =
    stabilized &&
    attempts === 1 &&
    initialContentHeight != undefined &&
    initialContentHeight <= viewport.height
  if (skipSettledMeasure) {
    log.debug(
      `Skipping post-stabilization height re-measure for story ${storyId}: stabilized on the ` +
        `first attempt and content (${initialContentHeight}px) fit the viewport`,
    )
  } else {
    const settledContentHeight = await measureContentHeight(browser)
    if (settledContentHeight != undefined) {
      const fittedHeight = computeFittedHeight(settledContentHeight, currentViewport)
      // Only grow the viewport; never shrink (shrinking could clip content that was visible in the
      // captured screenshot, and would not fix the cutoff bug).
      if (fittedHeight > currentViewport.height) {
        log.info(
          `Post-stabilization viewport fit for story ${storyId}: growing height from ` +
            `${currentViewport.height} to ${fittedHeight} (content: ${settledContentHeight})`,
        )
        currentViewport = { ...currentViewport, height: fittedHeight }
        await setViewportCached(browser, currentViewport)
        // Let the relayout settle, then capture the full-height screenshot.
        await browser.pause(WORKER_POST_LOAD_DELAY_MS)
        try {
          finalScreenshotBuffer = await takeScreenshotWithRetry(browser, previousScreenshotPath)
        } catch (err) {
          log.error(
            err,
            `Failed to capture full-height screenshot for story ${storyId} after resize. ` +
              `Using last captured screenshot.`,
          )
        }
      }
    }
  }

  // Rename the final selected screenshot file to the official path
  log.debug(
    `Using final screenshot buffer (${finalScreenshotBuffer.byteLength} bytes) saved to ${outputFilePath}`,
  )
  // Write the final buffer to the output path
  await fsPromises.writeFile(outputFilePath, finalScreenshotBuffer)

  // Clean up the other temp file
  await fsPromises.unlink(currentScreenshotPath).catch((err: unknown) => {
    log.warn(err, `Failed to delete unused temp screenshot ${currentScreenshotPath}`)
  })
  // --- End Screenshot Logic ---
  log.info(`Stable screenshot saved to ${outputFilePath}`)
  return outputFilePath
}

/** Max stored length of a failed result's `errorMessage` column. */
const MAX_ERROR_MESSAGE_LENGTH = 2000

/**
 * Idempotently persists a story's TestResult keyed on (screenshot_test_id, story_id) — the
 * unique `IDX_test_results_test_story` index (issue #456, cross-worker sharding groundwork).
 * A story retry (or, once sharding lands, a re-run shard) overwrites the previous attempt's row
 * instead of inserting a duplicate. TypeORM resolves the `screenshotTest` conflict path to the
 * relation's `screenshot_test_id` join column, includes every defined entity column in the
 * ON CONFLICT update set (callers must therefore set stale-able columns explicitly, even to
 * null), and bumps `updated_at` via its column default. The row id (RETURNING) is copied back
 * onto the entity so callers can log/reference it like a plain save.
 */
async function upsertTestResult(
  testResultTable: Repository<TestResult>,
  testResult: TestResult,
): Promise<void> {
  const insertResult = await testResultTable.upsert(testResult, {
    conflictPaths: ["screenshotTest", "storyId"],
  })
  const id = (insertResult.identifiers[0] as { id?: number } | undefined)?.id
  if (id != undefined) {
    testResult.id = id
  }
}

/**
 * Captures one story with per-story retry on infrastructure failures (issues #450/#454). This is
 * the session-holding half of the capture/finalize split (issue #456): the retry loop wraps ONLY
 * the browser-facing capture phase, so an infra retry re-captures without repeating any S3 work,
 * and the session is back in the pool the moment capture ends.
 *
 * Each attempt checks a session out of the pool, health-probes it (replacing it if dead — a dead
 * session would otherwise burn the webdriver package's hardcoded 60 s BiDi command timeout per
 * command), and captures via {@link captureStory}. On failure the error is classified:
 *
 *  - story-class (the story threw, never became ready, or an unrecognized error): recorded
 *    immediately as a `failed` TestResult with its error kind — retrying would just fail again.
 *  - infra-class (dead session, command timeout): the session's failure counter is bumped
 *    (condemning it for replacement at the pool's threshold) and the story is retried on the
 *    next attempt, up to WORKER_STORY_MAX_ATTEMPTS total attempts.
 *
 * Never throws for per-story failures — one story (or one dead session) must not abort the whole
 * build. Together with {@link finalizeStoryWithRecording}, exactly one TestResult row is
 * persisted per story in all paths: a `recorded` outcome IS the story's final (failed) row, and
 * a `captured` outcome produces its single row during finalize.
 */
export async function captureStoryWithRetry(
  info: Omit<StoryInfo, "browser"> & { pool: BrowserPool },
): Promise<CaptureOutcome<CapturedStory, TestResult>> {
  const { pool, ...storyInfo } = info
  const { story, projectId, uploadId } = storyInfo
  const maxAttempts = Math.max(1, WORKER_STORY_MAX_ATTEMPTS)
  const logChild = log.child({ projectId, uploadId, storyId: story.id })

  let lastInfraError: ClassifiedStoryError | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = await pool.acquire()
    try {
      // Detect a dead session cheaply before paying a full per-story command-timeout chain
      // (issue #450). replace() swaps in a fresh browser in place.
      if (!(await probeSession(session.browser))) {
        logChild.warn(
          { sessionId: session.id, attempt },
          "Browser session failed health probe; replacing it",
        )
        await pool.replace(session, "probe-failed")
      }
      // Read the browser AFTER probe/replace so a replacement is picked up.
      const captured = await captureStory({ ...storyInfo, browser: session.browser })
      session.consecutiveInfraFailures = 0
      session.storiesRendered++
      return { kind: "captured", captured }
    } catch (err) {
      const classified = classifyStoryError(err)
      if (classified.errorClass === "story") {
        logChild.error(
          { err, kind: classified.kind, attempt },
          `Story ${story.id} failed to render (${classified.kind}); recording failed result`,
        )
        return { kind: "recorded", result: await recordErrorTestResult(storyInfo, classified) }
      }
      // Infra-class: condemn the session towards replacement and retry on the next attempt.
      session.consecutiveInfraFailures++
      lastInfraError = classified
      logChild.warn(
        { err, kind: classified.kind, attempt, maxAttempts, sessionId: session.id },
        `Infra failure capturing story ${story.id} (${classified.kind}); ` +
          (attempt < maxAttempts ? "retrying on a healthy session" : "attempt budget exhausted"),
      )
    } finally {
      await pool.release(session)
    }
  }

  // Attempt budget exhausted: record the last infra failure so reviewers can distinguish
  // "the harness failed" from "the story is broken" (issue #454).
  return {
    kind: "recorded",
    result: await recordErrorTestResult(
      storyInfo,
      lastInfraError ?? { errorClass: "infra", kind: "unknown", message: "Unknown infra failure" },
    ),
  }
}

/**
 * Finalizes a captured story (S3 uploads, baseline diff, TestResult save — no browser held),
 * recording rather than throwing per-story failures so the build continues (issue #456).
 *
 * A {@link StorageError} (S3 screenshot/diff PUT) gets ONE cheap retry — the screenshot buffer
 * is already in memory, so retrying costs no browser time — then the failure is recorded as a
 * `failed` TestResult with its classified kind (`storage` for S3 failures) via
 * {@link recordErrorTestResult}. The story is never re-captured for a finalize failure.
 */
export async function finalizeStoryWithRecording(
  info: Omit<StoryInfo, "browser">,
  captured: CapturedStory,
): Promise<TestResult> {
  const { story, projectId, uploadId } = info
  const logChild = log.child({ projectId, uploadId, storyId: story.id })

  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await finalizeStory(info, captured)
    } catch (err) {
      lastError = err
      if (err instanceof StorageError && attempt === 1) {
        logChild.warn(
          { err, attempt },
          `Storage failure finalizing story ${story.id}; retrying finalize once`,
        )
        continue
      }
      break
    }
  }

  const classified = classifyStoryError(lastError)
  logChild.error(
    { err: lastError, kind: classified.kind },
    `Failed to finalize story ${story.id} (${classified.kind}); recording failed result`,
  )
  return await recordErrorTestResult(info, classified)
}

/**
 * Renders one story end to end: capture (with session checkout, health probing, and infra retry)
 * followed by finalize (with failure recording). Composition of {@link captureStoryWithRetry}
 * and {@link finalizeStoryWithRecording} for callers that don't pipeline the two phases; the
 * concurrent render fan-out in ingest.ts runs the phases through `runStoryPipeline` instead so
 * the session is released before the S3/diff/DB work begins (issue #456).
 *
 * Exactly one TestResult row is persisted per story in all paths, and this never throws for
 * per-story failures.
 */
export async function processStoryWithRetry(
  info: Omit<StoryInfo, "browser"> & { pool: BrowserPool },
): Promise<TestResult> {
  const { pool: _pool, ...storyInfo } = info
  const outcome = await captureStoryWithRetry(info)
  if (outcome.kind === "recorded") {
    return outcome.result
  }
  return await finalizeStoryWithRecording(storyInfo, outcome.captured)
}

/**
 * Persists the single `failed` TestResult row for a story that could not be rendered (issue #152
 * failure isolation: the build keeps going). `newImageUrl` is NOT NULL with no screenshot for a
 * failed story, so it is stored as an empty string. `errorKind`/`errorMessage` (issue #454) let
 * the API/UI distinguish infra failures from genuine story failures.
 */
async function recordErrorTestResult(
  { story, screenshotTest, testResultTable }: Omit<StoryInfo, "browser">,
  classified: ClassifiedStoryError,
): Promise<TestResult> {
  const testResult = new TestResult()
  testResult.name = getStoryName(story)
  testResult.screenshotTest = screenshotTest
  testResult.storyId = story.id
  testResult.story = story
  testResult.newImageUrl = ""
  testResult.baselineImageUrl = null
  testResult.diffImageUrl = null
  testResult.diffRatio = null
  testResult.changeStatus = "failed"
  testResult.errorKind = classified.kind
  testResult.errorMessage = classified.message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
  await upsertTestResult(testResultTable, testResult)
  return testResult
}

/**
 * The output of a story's session-holding capture phase (issue #456): everything the
 * browser-free finalize phase needs to upload, diff, and persist the story's result.
 */
export interface CapturedStory {
  story: Story
  /** Path the stabilized screenshot was written to (under the build's tmp dir). */
  screenshotPath: string
  /** The stabilized screenshot bytes, buffered so finalize never re-reads the browser. */
  screenshotBuffer: Buffer
  /** The viewport the story was captured at (pre-content-fit adjustments). */
  viewport: SetViewportOptions
  /** Wall-clock duration of the capture phase, for logging/telemetry. */
  captureDurationMs: number
}

/**
 * Capture phase (session-holding): navigate to the story, wait for its render lifecycle to
 * complete (issue #458), stabilize, and save the final screenshot. THROWS on failure — error
 * classification, recording, and retry policy live in {@link captureStoryWithRetry}. Holds the
 * browser for the minimum span: no S3 or database work happens here (issue #456).
 */
export async function captureStory({
  story,
  tmpDir,
  projectId,
  uploadId,
  port,
  browser,
}: StoryInfo): Promise<CapturedStory> {
  const storyId = story.id
  const viewport = getStoryViewport(story)
  const logChild = log.child({ projectId, uploadId, storyId, storyName: story.name, viewport })
  logChild.info("Processing story")
  const captureStartMs = Date.now()

  const localScreenshotPath = path.join(tmpDir, `${storyId}.png`)
  const screenshotTempDir = path.join(tmpDir, "stabilization") // Subdir for temp files
  await fsPromises.mkdir(screenshotTempDir, { recursive: true })

  await captureStableScreenshot(
    browser,
    story,
    viewport,
    port,
    screenshotTempDir,
    localScreenshotPath,
  )

  // Read the saved screenshot buffer for upload and comparison
  const screenshotBuffer = await fsPromises.readFile(localScreenshotPath)

  return {
    story,
    screenshotPath: localScreenshotPath,
    screenshotBuffer,
    viewport,
    captureDurationMs: Date.now() - captureStartMs,
  }
}

/**
 * Finalize phase (no browser): upload the captured screenshot, compare against the baseline
 * (when present), upload the diff, and persist the TestResult row. THROWS on failure (S3
 * persistence is StorageError-wrapped) — error recording lives in
 * {@link finalizeStoryWithRecording}. A missing/corrupt baseline is NOT a failure: it downgrades
 * the result to "new".
 */
export async function finalizeStory(
  {
    story,
    screenshotTest,
    baseTestResult,
    bucket,
    tmpDir,
    projectId,
    uploadId,
    s3Client,
    testResultTable,
  }: Omit<StoryInfo, "browser">,
  captured: CapturedStory,
): Promise<TestResult> {
  const storyId = story.id
  const { screenshotBuffer, captureDurationMs } = captured
  let logChild = log.child({ projectId, uploadId, storyId, storyName: story.name })

  // Upload screenshot to S3. Wrapped in StorageError so an upload failure is classified as a
  // storage infra failure instead of aborting the whole build (issue #454).
  const screenshotKey = buildScreenshotKey(projectId, uploadId, storyId)
  logChild.debug({ screenshotKey }, `Uploading screenshot to S3: ${screenshotKey}`)
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: screenshotKey,
        Body: screenshotBuffer,
        ContentType: "image/png",
      }),
    )
  } catch (err) {
    throw new StorageError(`Failed to upload screenshot for story ${storyId} to S3`, err)
  }
  // Store the S3 object key (not a public URL); the bucket is private and images are served via
  // presigned URLs generated at read time (see api/src/s3.ts, worker/src/s3.ts).
  const newImageUrl = screenshotKey
  logChild = logChild.child({ newImageUrl, newImageBytes: screenshotBuffer.length })
  logChild.info("Successfully uploaded screenshot to S3")

  let changeStatus: TestResultStatus = "new"
  let baselineImageUrl: string | null = null
  let diffImageUrl: string | null = null
  let diffRatio = 0

  if (baseTestResult) {
    // Attempt to download baseline screenshot
    logChild = logChild.child({ baseTestResult })
    logChild.debug(`Base test result for story ${storyId}`)
    if (!baseTestResult.screenshotTest.uploadId) {
      logChild.warn("Base test result has missing screenshotTest or uploadId reference")
      changeStatus = "new"
    } else {
      const baselineKey = buildScreenshotKey(
        projectId,
        baseTestResult.screenshotTest.uploadId,
        storyId,
      )
      baselineImageUrl = baselineKey
      logChild = logChild.child({ baselineImageUrl })
      try {
        const baselinePath = path.join(tmpDir, `${storyId}-baseline.png`)
        await downloadImage({ s3Client, bucket, key: baselineKey, filePath: baselinePath })

        // Load the new and baseline PNG images
        const newImageBuffer = screenshotBuffer
        const baselineImageBuffer = await fsPromises.readFile(baselinePath)
        const newPng = PNG.sync.read(newImageBuffer)
        const baselinePng = PNG.sync.read(baselineImageBuffer)

        if (newPng.width !== baselinePng.width) {
          logChild.info(
            {
              baselineSize: { width: baselinePng.width, height: baselinePng.height },
              newSize: { width: newPng.width, height: newPng.height },
            },
            `Image width mismatch for story ${storyId}`,
          )
          changeStatus = "changed"
          diffRatio = 1
        } else {
          const diffRes = diffImages(newPng, baselinePng)
          diffRatio = diffRes.diffRatio

          // Changed when both floors are met: an absolute pixel count (size-
          // independent, so small text changes flag on full-page stories too)
          // and a diff ratio (0 by default; a raisable escape hatch for
          // deployments with nondeterministic stories).
          const meetsFloors =
            diffRes.numDiffPixels > 0 &&
            diffRes.numDiffPixels >= WORKER_CHANGED_MIN_PIXELS &&
            diffRatio >= WORKER_CHANGED_THRESHOLD
          changeStatus = meetsFloors ? "changed" : "unchanged"
          logChild.debug({ diffRatio, changeStatus }, `Diff ratio for story ${storyId}`)

          // Write and upload the diff image
          const diffPath = path.join(tmpDir, `${storyId}-diff.png`)
          await fsPromises.writeFile(diffPath, PNG.sync.write(diffRes.diffMask))
          const diffKey = diffImageKey(projectId, uploadId, storyId)
          logChild.debug({ diffKey }, "Uploading diff image to S3")
          // Wrapped in StorageError (outside the baseline try/catch below via rethrow) so a diff
          // upload failure is a retryable infra failure, not a silent "new" downgrade.
          try {
            await s3Client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: diffKey,
                Body: await fsPromises.readFile(diffPath),
                ContentType: "image/png",
              }),
            )
          } catch (err) {
            throw new StorageError(`Failed to upload diff image for story ${storyId} to S3`, err)
          }
          diffImageUrl = diffKey
          logChild.info(
            { diffImageUrl, diffImageBytes: diffRes.diffMask.data.byteLength },
            "Successfully uploaded diff image to S3",
          )
        }
      } catch (err) {
        // A diff-upload StorageError is a real infra failure and must propagate to the retry
        // loop; only baseline download/decode problems downgrade the result to "new".
        if (err instanceof StorageError) {
          throw err
        }
        logChild.warn({ err }, "Baseline screenshot not available")
        changeStatus = "new"
      }
    }
  }

  // Create test result record
  const name = getStoryName(story)
  logChild.debug({ name, storyId }, "Creating test result record")
  const testResult = new TestResult()
  testResult.name = name
  testResult.screenshotTest = screenshotTest
  testResult.storyId = storyId
  testResult.story = story
  testResult.newImageUrl = newImageUrl
  testResult.baselineImageUrl = baselineImageUrl
  testResult.diffImageUrl = diffImageUrl
  testResult.diffRatio = diffRatio
  testResult.changeStatus = changeStatus
  // Explicit nulls (not undefined) so the idempotent upsert CLEARS a previous failed attempt's
  // error columns when the retry succeeds — undefined fields are omitted from the update set.
  testResult.errorKind = null
  testResult.errorMessage = null
  await upsertTestResult(testResultTable, testResult)
  logChild.debug(
    { testResultId: testResult.id, captureDurationMs },
    "Successfully saved test result record",
  )

  return testResult
}

/**
 * Renders one story against the given browser session and persists its TestResult: the capture
 * phase ({@link captureStory}) followed immediately by the finalize phase ({@link finalizeStory})
 * on the caller's session. THROWS on failure. Kept as the sequential composition of the two
 * phases; the concurrent fan-out releases the session between the phases instead (issue #456).
 */
export async function renderStory(info: StoryInfo): Promise<TestResult> {
  const captured = await captureStory(info)
  return await finalizeStory(info, captured)
}

interface DownloadImageArgs {
  s3Client: S3Client
  bucket: string
  key: string
  filePath: string
  timeoutMs?: number
}

async function downloadImage({
  s3Client,
  bucket,
  key,
  filePath,
  timeoutMs = 30 * 1000,
}: DownloadImageArgs): Promise<void> {
  const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!resp.Body) {
    throw new Error("Empty baseline response")
  }

  const writeStream = fs.createWriteStream(filePath)
  await new Promise<void>((resolve, reject) => {
    let isSettled = false

    const handleSettled = (err?: Error) => {
      if (isSettled) {
        return
      }
      isSettled = true
      clearTimeout(timeout)

      // Clean up resources
      if (resp.Body instanceof Readable) {
        resp.Body.destroy()
      }

      // Complete the promise
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }

    const timeout = setTimeout(() => {
      handleSettled(new Error(`Download timeout for image ${key}`))
    }, timeoutMs)

    if (resp.Body instanceof Readable) {
      resp.Body.pipe(writeStream)
        .on("finish", () => handleSettled())
        .on("error", (err) => handleSettled(err))
    } else {
      handleSettled(new Error("Baseline response body is not a readable stream"))
    }

    // Handle the case where the writeStream errors
    writeStream.on("error", (err) => handleSettled(err))
  })
}

async function takeScreenshotWithRetry(
  browser: Browser,
  screenshotPath: string,
  maxRetries = 3,
  timeoutMs = 10 * 1000, // 10 second timeout per attempt
): Promise<Buffer<ArrayBuffer>> {
  const RETRY_DELAY_MS = 1000

  return await new Promise<Buffer<ArrayBuffer>>((resolve, reject) => {
    let isSettled = false
    let timeoutId: NodeJS.Timeout | null = null

    const handleSettled = (result?: Buffer<ArrayBuffer>, err?: Error) => {
      if (isSettled) {
        return
      }
      isSettled = true

      // Clear the timeout if it exists
      if (timeoutId) {
        clearTimeout(timeoutId)
      }

      // Resolve or reject based on result/error
      if (err) {
        reject(err)
      } else if (result) {
        resolve(result)
      } else {
        reject(new Error("No result and no error (should never happen)"))
      }
    }

    // Set timeout for the entire operation
    timeoutId = setTimeout(() => {
      handleSettled(
        undefined,
        new Error(`Screenshot timed out after ${timeoutMs}ms for ${screenshotPath}`),
      )
    }, timeoutMs)

    // Execute screenshot with retries
    const attemptScreenshot = async () => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          log.debug(`Taking screenshot: ${screenshotPath} (attempt ${i + 1}/${maxRetries})`)
          const result = await browser.saveScreenshot(screenshotPath)
          handleSettled(result)
          return
        } catch (err) {
          if (i === maxRetries - 1 || isSettled) {
            // Last retry or already settled (e.g. timeout occurred)
            handleSettled(undefined, err instanceof Error ? err : new Error("Screenshot failed"))
            return
          }
          log.warn(`Screenshot attempt ${i + 1} failed, waiting and retrying...`)
          await browser.pause(RETRY_DELAY_MS)
        }
      }
      // This should never be reached due to the error handling above
      handleSettled(undefined, new Error("Screenshot failed after max retries"))
    }

    // Start the screenshot process
    attemptScreenshot().catch((err: unknown) => {
      log.error(err, `Unhandled error in screenshot process for ${screenshotPath}`)
      handleSettled(undefined, err instanceof Error ? err : new Error(String(err)))
    })
  })
}

/**
 * Measures the full rendered content height of the current page via the browser. Returns the
 * larger of `document.body.scrollHeight` and `document.documentElement.scrollHeight`, or
 * `undefined` if the measurement fails.
 */
async function measureContentHeight(browser: Browser): Promise<number | undefined> {
  try {
    const contentHeight = await browser.execute(() => {
      // @ts-expect-error: document is not defined
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const b = document.body as { scrollHeight?: number } | undefined
      // @ts-expect-error: document is not defined
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const h = document.documentElement as { scrollHeight?: number } | undefined
      // Ensure elements exist before accessing properties
      const bodyScrollHeight = b?.scrollHeight ?? 0
      const docScrollHeight = h?.scrollHeight ?? 0
      return Math.max(bodyScrollHeight, docScrollHeight)
    })
    return contentHeight
  } catch (err) {
    log.error(err, "Failed to measure content height")
    return undefined
  }
}

/**
 * Computes the viewport height needed to capture the full content, respecting the original
 * viewport height as a floor and applying browser/pixel limits as a ceiling.
 */
function computeFittedHeight(contentHeight: number, viewport: SetViewportOptions): number {
  const MAX_HEIGHT = 32767
  const MAX_PIXELS = 25_000_000

  // Calculate desired height, respecting content and initial viewport
  const desiredHeight = Math.max(viewport.height, contentHeight)
  // Apply maximum height limit
  const limitedHeight = Math.min(desiredHeight, MAX_HEIGHT)
  // Apply maximum pixel limit
  const pixelLimitedHeight = Math.floor(MAX_PIXELS / viewport.width)
  // Determine the final height, constrained by both limits
  return Math.min(limitedHeight, pixelLimitedHeight)
}

/**
 * Given the measured content height of the loaded story (undefined when measurement failed), if
 * it exceeds the current viewport height, grows the viewport so the full content is captured.
 * Returns the height the viewport was set to (or the original height if no adjustment was made
 * or measurement failed).
 *
 * Note: immediately after a story loads the layout may not have settled, so the content height
 * measured here can be too small (this is the root cause of tall pages being cut off). The
 * stabilization loop performs a second, authoritative adjustment once rendering has settled.
 */
async function adjustViewportForStory(
  browser: Browser,
  storyId: string,
  viewport: SetViewportOptions,
  contentHeight: number | undefined,
): Promise<number> {
  const originalHeight = viewport.height

  if (contentHeight == undefined) {
    log.error(
      `Failed to get content height for story ${storyId}. Using original height: ${originalHeight}`,
    )
    // If measurement failed, ensure the viewport is at its original dimensions (a no-op BiDi
    // call when the cached viewport already matches, issue #474).
    await setViewportCached(browser, viewport)
    return originalHeight
  }
  log.debug(`Content height for story ${storyId}: ${contentHeight}`)

  const finalHeight = computeFittedHeight(contentHeight, viewport)

  if (finalHeight !== originalHeight) {
    log.info(
      `Adjusting viewport height for story ${storyId} from ${originalHeight} to ${finalHeight} ` +
        `(content: ${contentHeight})`,
    )
    await setViewportCached(browser, {
      width: viewport.width,
      height: finalHeight,
      devicePixelRatio: viewport.devicePixelRatio,
    })
    // Add a small pause after resize to allow layout shifts
    await browser.pause(100)
  } else {
    log.debug(`Keeping original viewport height ${originalHeight} for story ${storyId}`)
  }
  return finalHeight
}

function getStoryName(story: Story): string {
  // Stories have `title` fields that look like "stories/components/NewProjectDialog" and `name`
  // fields based on the exported variable name in the file. Strip the leading "stories/" (if any)
  // and append "/${name}" to get the full story name, then trim down to the last 255 characters.
  const { name, title } = story
  const cleanedTitle = title.startsWith("stories/") ? title.slice(8) : title
  return `${cleanedTitle}/${name}`.slice(-255)
}

function clamp(value: number, min: number, max: number): number | undefined {
  if (isNaN(value) || !isFinite(value)) {
    return undefined
  }
  return Math.min(Math.max(value, min), max)
}
