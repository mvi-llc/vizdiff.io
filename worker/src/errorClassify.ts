import type { TestResultErrorKind } from "shared"

import { StoryRenderError, StoryRenderTimeoutError } from "./storyReady"

/**
 * Per-story error classification (issue #454).
 *
 * "story" means the story itself is broken (it threw, or never became ready): recording it as a
 * permanent `failed` result is correct, and retrying would just fail again. "infra" means the
 * harness failed (dead browser session, command timeout, storage I/O): the story may be perfectly
 * fine, so the render loop retries it on a healthy session before recording anything.
 */
export type StoryErrorClass = "infra" | "story"

export interface ClassifiedStoryError {
  errorClass: StoryErrorClass
  kind: TestResultErrorKind
  message: string
}

/**
 * An S3 upload/download failure while persisting a story's screenshot or diff image. Wrapping the
 * raw SDK error lets classification treat storage as an infra failure (retryable) instead of the
 * previous behavior where an uncaught screenshot-upload rejection aborted the whole build.
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message)
    this.name = "StorageError"
  }
}

/** Dead/vanished browser session and connection-level failures (infra: "browser-gone"). */
const BROWSER_GONE_REGEX =
  /invalid session id|session (deleted|not (created|started))|browsing context .* (not found|discarded)|no such window|WebSocket .* (closed|not connected)|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed/i

/** The webdriver package's hardcoded 60 s BiDi command timeout (infra: "browser-timeout"). */
const COMMAND_TIMEOUT_REGEX = /Command \S+ with id \d+.*timed out/

/** Exact failure messages thrown by `takeScreenshotWithRetry` (infra: "screenshot-failed"). */
const SCREENSHOT_FAILED_REGEX =
  /Screenshot timed out after \d+ms|Screenshot failed after max retries/

/** Story-load timeouts from `waitUntil` on navigation (story: the bundle never booted). */
const STORY_LOAD_TIMEOUT_REGEX = /Story failed to load within|Storybook failed to load stories/

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}

/**
 * Classifies a per-story render error as infra vs story, with the {@link TestResultErrorKind}
 * recorded on a failed TestResult. Rules are ordered; the first match wins. Unrecognized errors
 * default to story/"unknown" — a retry storm on a genuinely broken story is worse than an
 * occasionally mislabeled one-off.
 */
export function classifyStoryError(err: unknown): ClassifiedStoryError {
  const message = errorMessage(err)

  // 1. Semantic story-render outcomes (issue #458) are definitively story-class.
  if (err instanceof StoryRenderError) {
    return { errorClass: "story", kind: "story-error", message }
  }
  if (err instanceof StoryRenderTimeoutError) {
    return {
      errorClass: "story",
      kind: err.reason === "ready-signal" ? "ready-signal-timeout" : "render-timeout",
      message,
    }
  }

  // 2. The story/storybook never loaded within its waitUntil budget.
  if (STORY_LOAD_TIMEOUT_REGEX.test(message)) {
    return { errorClass: "story", kind: "story-load-timeout", message }
  }

  // 3. Screenshot/diff persistence failed (S3), wrapped by renderStory.
  if (err instanceof StorageError) {
    return { errorClass: "infra", kind: "storage", message }
  }

  // 4. The browser session is gone (crashed Chrome, dropped WebSocket, dead driver connection).
  if (
    BROWSER_GONE_REGEX.test(message) ||
    (err instanceof Error && err.name === "WebDriverRequestError")
  ) {
    return { errorClass: "infra", kind: "browser-gone", message }
  }

  // 5. A BiDi command burned its 60 s timeout, or screenshot capture failed/timed out — the
  // session is unresponsive even if not yet provably dead.
  if (COMMAND_TIMEOUT_REGEX.test(message)) {
    return { errorClass: "infra", kind: "browser-timeout", message }
  }
  if (SCREENSHOT_FAILED_REGEX.test(message)) {
    return { errorClass: "infra", kind: "screenshot-failed", message }
  }

  // 6. Default: story-class, no retry.
  return { errorClass: "story", kind: "unknown", message }
}
