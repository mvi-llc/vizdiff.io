import type { Browser } from "webdriverio"

import { log } from "./log"

/**
 * Per-session failure diagnostics (issue #475).
 *
 * A failed story used to surface exactly one error line, leaving the operator to kubectl-log
 * archaeology. This module buffers, per browser session, the context needed to diagnose a
 * failure at a glance:
 *
 *  - **Browser console output** (BiDi `log.entryAdded`, which delivers both `console` entries and
 *    `javascript` entries — page exceptions/unhandled rejections) in a bounded ring buffer,
 *    tagged with the story being captured at the time.
 *  - **In-flight network requests** (BiDi `network.beforeRequestSent` minus
 *    `network.responseCompleted`/`network.fetchError`), so a wedged ready signal reads as
 *    "worker.js pending 60s" instead of a bare timeout.
 *  - **A best-effort failure-time screenshot** of whatever the page was showing when the story
 *    failed, captured on demand by {@link collectFailureDiagnostics}.
 *
 * State is keyed on the Browser object itself in a WeakMap — the same idiom as
 * SessionCaptureState in stories.ts — so BrowserPool's `replace()` (which swaps a brand-new
 * Browser instance into the session) invalidates the old session's buffers automatically.
 *
 * Everything here is always-on with hard caps (no env knobs): the buffers are small, the event
 * handlers are O(1), and collection only happens on the failure path.
 */

/** One buffered browser console/exception entry. */
export interface ConsoleEntry {
  /** BiDi log level ("debug" | "info" | "warn" | "error"). */
  level: string
  /** The entry text, truncated to {@link MAX_CONSOLE_TEXT_LENGTH} characters. */
  text: string
  /** Entry timestamp in epoch milliseconds (BiDi timestamp, or receipt time as fallback). */
  stampMs: number
  /** The story being captured when the entry arrived, if any (see {@link setCurrentStory}). */
  storyId?: string
}

/** One in-flight network request at collection time. */
export interface PendingRequestInfo {
  /** Request URL, truncated to {@link MAX_PENDING_URL_LENGTH} characters. */
  url: string
  /** How long the request had been pending at collection time, in milliseconds. */
  pendingMs: number
}

/** Everything {@link collectFailureDiagnostics} gathered for one failed story. */
export interface CollectedDiagnostics {
  consoleTail: ConsoleEntry[]
  pendingRequests: PendingRequestInfo[]
  /** Failure-time screenshot (PNG bytes), when requested and the capture succeeded in time. */
  screenshotBuffer?: Buffer
}

/** Ring-buffer capacity for console entries per session. */
const MAX_CONSOLE_ENTRIES = 200
/** Maximum stored length of one console entry's text. */
const MAX_CONSOLE_TEXT_LENGTH = 500
/** Maximum console entries returned in a failure's tail. */
const CONSOLE_TAIL_LIMIT = 50
/** Maximum tracked in-flight requests per session (oldest evicted on insert). */
const MAX_PENDING_REQUESTS = 500
/** Pending requests older than this are presumed leaked (missed completion event) and evicted. */
const PENDING_REQUEST_MAX_AGE_MS = 5 * 60 * 1000
/** Maximum pending requests reported per failure. */
const PENDING_REQUESTS_LIMIT = 20
/** Maximum reported length of a pending request URL. */
const MAX_PENDING_URL_LENGTH = 500
/** Default budget for the best-effort failure-time screenshot. */
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 5000

interface PendingRequestState {
  url: string
  startedMs: number
}

interface SessionDiagState {
  /** Console/exception ring buffer, oldest first, capped at {@link MAX_CONSOLE_ENTRIES}. */
  consoleEntries: ConsoleEntry[]
  /** In-flight requests by BiDi request id. */
  pending: Map<string, PendingRequestState>
  /** The story currently being captured on this session, if any. */
  currentStoryId?: string
  /** When the current story's capture attempt began (Date.now() at {@link setCurrentStory}). */
  captureStartMs: number
}

const sessionDiagState = new WeakMap<Browser, SessionDiagState>()

function getState(browser: Browser): SessionDiagState {
  let state = sessionDiagState.get(browser)
  if (!state) {
    state = { consoleEntries: [], pending: new Map(), captureStartMs: 0 }
    sessionDiagState.set(browser, state)
  }
  return state
}

/** Minimal shape of the BiDi `log.entryAdded` payload we use (WebdriverIO emits `params`). */
interface LogEntryAddedEvent {
  level?: string
  text?: string | null
  timestamp?: number
}

/** Minimal shape of the BiDi network event payloads we use. */
interface NetworkRequestEvent {
  request?: {
    request?: string
    url?: string
  }
}

/**
 * Subscribes the session to the BiDi log/network events backing failure diagnostics and starts
 * buffering them. Must be called once per browser session, after session creation (the same
 * place the safeguards and render-state hooks are installed — see createStoryBrowserPool), so
 * replacement browsers are covered too.
 *
 * Note: the network egress safeguard (safeguards.ts) also subscribes to
 * `network.beforeRequestSent`; double-subscribing the same BiDi event on one session is fine —
 * the driver delivers one event, and each module's `browser.on` handler runs independently.
 *
 * Swallows install failures with a warning: diagnostics are troubleshooting sugar and must never
 * take down rendering (mirrors installBrowserSafeguards).
 */
export async function installSessionDiagnostics(browser: Browser): Promise<void> {
  try {
    await browser.sessionSubscribe({
      events: [
        "log.entryAdded",
        "network.beforeRequestSent",
        "network.responseCompleted",
        "network.fetchError",
      ],
    })

    browser.on("log.entryAdded", (event: LogEntryAddedEvent) => {
      const state = getState(browser)
      const entry: ConsoleEntry = {
        level: event.level ?? "info",
        text: (event.text ?? "").slice(0, MAX_CONSOLE_TEXT_LENGTH),
        stampMs: event.timestamp ?? Date.now(),
      }
      if (state.currentStoryId != undefined) {
        entry.storyId = state.currentStoryId
      }
      state.consoleEntries.push(entry)
      if (state.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
        state.consoleEntries.splice(0, state.consoleEntries.length - MAX_CONSOLE_ENTRIES)
      }
    })

    browser.on("network.beforeRequestSent", (event: NetworkRequestEvent) => {
      const requestId = event.request?.request
      if (requestId == undefined) {
        return
      }
      const state = getState(browser)
      const nowMs = Date.now()
      // Evict presumed-leaked entries (a missed completion event must not pin memory forever).
      for (const [id, pending] of state.pending) {
        if (nowMs - pending.startedMs > PENDING_REQUEST_MAX_AGE_MS) {
          state.pending.delete(id)
        }
      }
      // Hard cap: evict oldest-inserted entries to make room.
      while (state.pending.size >= MAX_PENDING_REQUESTS) {
        const oldest = state.pending.keys().next().value
        if (oldest == undefined) {
          break
        }
        state.pending.delete(oldest)
      }
      state.pending.set(requestId, { url: event.request?.url ?? "", startedMs: nowMs })
    })

    const settleRequest = (event: NetworkRequestEvent): void => {
      const requestId = event.request?.request
      if (requestId != undefined) {
        getState(browser).pending.delete(requestId)
      }
    }
    browser.on("network.responseCompleted", settleRequest)
    browser.on("network.fetchError", settleRequest)

    log.info("Installed session failure diagnostics (console + network buffering)")
  } catch (err) {
    // BiDi may be unavailable depending on the driver. Diagnostics are best-effort; rendering
    // must proceed without them.
    log.warn(err, "Failed to install session failure diagnostics via BiDi")
  }
}

/**
 * Marks the story currently being captured on this session (or clears it with `undefined`), so
 * console entries arriving while the story renders are tagged with its id. Also records the
 * capture start time, letting {@link collectFailureDiagnostics} include untagged entries that
 * arrived during this capture attempt (e.g. events emitted before the tag was set, or on a
 * session whose diagnostics were installed without a story in flight).
 */
export function setCurrentStory(browser: Browser, storyId: string | undefined): void {
  const state = getState(browser)
  state.currentStoryId = storyId
  state.captureStartMs = Date.now()
}

/**
 * Returns the session's in-flight requests as of `nowMs` (defaults to Date.now()), sorted
 * longest-pending first, capped at {@link PENDING_REQUESTS_LIMIT}, with URLs truncated.
 */
export function getPendingRequests(browser: Browser, nowMs?: number): PendingRequestInfo[] {
  const state = sessionDiagState.get(browser)
  if (!state) {
    return []
  }
  const now = nowMs ?? Date.now()
  return [...state.pending.values()]
    .map((pending) => ({
      url: pending.url.slice(0, MAX_PENDING_URL_LENGTH),
      pendingMs: Math.max(0, now - pending.startedMs),
    }))
    .sort((a, b) => b.pendingMs - a.pendingMs)
    .slice(0, PENDING_REQUESTS_LIMIT)
}

/**
 * Gathers the failing story's troubleshooting context while the session is still held: the
 * console tail (entries tagged with the story, plus untagged entries that arrived since the
 * capture attempt began), the current in-flight requests, and — when `opts.screenshot` is true —
 * a best-effort screenshot of the wedged page, raced against `opts.screenshotTimeoutMs`
 * (default 5000 ms) so a dead session cannot stall failure recording.
 *
 * NEVER throws: every stage is individually guarded, returning whatever partial data was
 * gathered. Callers pass `screenshot: false` for failure kinds where the session is known dead
 * or screenshots are known broken (browser-gone/browser-timeout/screenshot-failed).
 */
export async function collectFailureDiagnostics(
  browser: Browser,
  storyId: string,
  opts: { screenshot: boolean; screenshotTimeoutMs?: number },
): Promise<CollectedDiagnostics> {
  const result: CollectedDiagnostics = { consoleTail: [], pendingRequests: [] }

  try {
    const state = sessionDiagState.get(browser)
    if (state) {
      result.consoleTail = state.consoleEntries
        .filter(
          (entry) =>
            entry.storyId === storyId ||
            (entry.storyId == undefined && entry.stampMs >= state.captureStartMs),
        )
        .slice(-CONSOLE_TAIL_LIMIT)
      result.pendingRequests = getPendingRequests(browser)
    }
  } catch (err) {
    log.warn(err, `Failed to collect console/network diagnostics for story ${storyId}`)
  }

  if (opts.screenshot) {
    try {
      const base64 = await takeScreenshotWithTimeout(
        browser,
        opts.screenshotTimeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS,
      )
      if (base64 != undefined) {
        result.screenshotBuffer = Buffer.from(base64, "base64")
      } else {
        log.warn(`Failure-time screenshot for story ${storyId} timed out`)
      }
    } catch (err) {
      log.warn(err, `Failed to capture failure-time screenshot for story ${storyId}`)
    }
  }

  return result
}

/** Races `browser.takeScreenshot()` against a timeout; `undefined` means the timeout won. */
async function takeScreenshotWithTimeout(
  browser: Browser,
  timeoutMs: number,
): Promise<string | undefined> {
  const screenshotPromise = browser.takeScreenshot()
  // If the timeout wins the race, a later rejection would otherwise be unhandled.
  screenshotPromise.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      screenshotPromise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Test-only introspection: the session's full console ring buffer (oldest first). Production
 * code reads the buffer exclusively through {@link collectFailureDiagnostics}.
 */
export function getConsoleEntries(browser: Browser): readonly ConsoleEntry[] {
  return sessionDiagState.get(browser)?.consoleEntries ?? []
}

/**
 * Test-only introspection: how many in-flight requests the session is currently tracking
 * (pre-cap, unlike {@link getPendingRequests}).
 */
export function getPendingRequestCount(browser: Browser): number {
  return sessionDiagState.get(browser)?.pending.size ?? 0
}
