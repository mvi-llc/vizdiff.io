import type { Browser } from "webdriverio"

import { WORKER_STORY_DELAY_MAX_MS, WORKER_STORY_RENDER_TIMEOUT_MS } from "./environment"
import { log } from "./log"
import type { Story, StorybookWindow } from "./types"

/**
 * Story-render readiness for screenshot capture (issue #458).
 *
 * The worker previously captured on *visual quiescence* alone: wait for the Storybook preview to
 * boot, pause briefly, then compare consecutive screenshots until they stop changing. That misfires
 * for async/Suspense stories — the preview boots long before the story's lazy chunks load, and a
 * busy main thread (or a small spinner) makes the loading fallback read as "stable" — so roughly
 * half of a heavyweight Storybook could screenshot as loading spinners.
 *
 * This module waits on *semantic* readiness instead, the way Chromatic does:
 *
 *  1. An init script ({@link renderStateInitScript}) hooks the Storybook preview channel before
 *     any story code runs and records the story-render lifecycle events (`storyRendered`,
 *     `docsRendered`, `storyErrored`, ...) into a page global.
 *  2. {@link waitForStoryReady} polls that state (plus SB8's `preview.currentRender.phase`) after
 *     navigating to a story, and only returns once the render lifecycle has completed — or throws
 *     when it errors ({@link StoryRenderError}) or never completes ({@link StoryRenderTimeoutError}).
 *  3. Stories can opt into an explicit ready signal (`parameters.useReadySignal` /
 *     `parameters.vizdiff.waitForReady`) awaited via the `window.__VIZDIFF_STORY_READY__` global,
 *     and a minimum pre-capture delay (`parameters.vizdiff.delay` / `parameters.chromatic.delay`).
 *
 * The visual-stability loop in stories.ts still runs afterwards as the final settle check — it is
 * the right tool for animations, just not a substitute for render completion.
 */

/** A story-render lifecycle event recorded in the page by {@link renderStateInitScript}. */
export interface StoryRenderEvent {
  type: string
  storyId?: string
  message?: string
}

/** Page-global render state populated by {@link renderStateInitScript}. */
export interface VizdiffRenderState {
  events: StoryRenderEvent[]
  hooked: boolean
}

/** The page globals the render-state init script installs. */
export type RenderStateWindow = {
  __VIZDIFF_RENDER_STATE__?: VizdiffRenderState
  __VIZDIFF_STORY_READY__?: boolean
}

/** Channel events that mean the story (or docs page) finished rendering. */
const SUCCESS_EVENT_TYPES: ReadonlySet<string> = new Set(["storyRendered", "docsRendered"])

/** Channel events that mean the story failed to render. */
const FAILURE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "storyErrored",
  "storyThrewException",
  "playFunctionThrewException",
  "storyMissing",
])

/** The story failed to render: Storybook reported an error event or an "errored" render phase. */
export class StoryRenderError extends Error {
  constructor(storyId: string, detail?: string) {
    super(`Story ${storyId} failed to render${detail != undefined ? `: ${detail}` : ""}`)
    this.name = "StoryRenderError"
  }
}

/**
 * The story never signaled completion within the timeout. `reason` distinguishes the render
 * lifecycle never completing ("render") from an opted-in explicit ready signal never resolving
 * ("ready-signal").
 */
export class StoryRenderTimeoutError extends Error {
  constructor(
    storyId: string,
    timeoutMs: number,
    public readonly reason: "render" | "ready-signal",
  ) {
    super(
      reason === "render"
        ? `Story ${storyId} did not finish rendering within ${timeoutMs}ms`
        : `Story ${storyId} did not resolve its ready signal within ${timeoutMs}ms`,
    )
    this.name = "StoryRenderTimeoutError"
  }
}

/**
 * Page init-script source, evaluated in the page context before any Storybook/story script runs.
 * It is intentionally written as a self-contained function with no external references so it can
 * be serialized via `addInitScript` (same idiom as `safeguardInitScript` in safeguards.ts).
 *
 * Behavior:
 *  - Installs `window.__VIZDIFF_RENDER_STATE__ = { events: [], hooked: false }` and
 *    `window.__VIZDIFF_STORY_READY__ = false`.
 *  - Intercepts Storybook's assignment of `window.__STORYBOOK_ADDONS_CHANNEL__` (via a
 *    configurable accessor) and attaches listeners for the story-render lifecycle events:
 *    `storyRendered`/`docsRendered` (success) and `storyErrored`/`storyThrewException`/
 *    `playFunctionThrewException`/`storyMissing` (failure). Each event is recorded into
 *    `__VIZDIFF_RENDER_STATE__.events`; `hooked` flips to true once listeners are attached.
 *  - Falls back to polling for the channel (every 50 ms, up to 30 s) if the property already
 *    exists or cannot be redefined.
 */
export function renderStateInitScript(): void {
  // Runs in the browser. `window` is a page global.
  /* eslint-disable */
  // @ts-nocheck
  try {
    // @ts-ignore
    const w: any = window
    const state = { events: [] as any[], hooked: false }
    w.__VIZDIFF_RENDER_STATE__ = state
    // Reset per document: stories opting into the ready-signal convention set this to true once
    // their async scene is actually drawn (see docs/CONFIGURATION.md "Story readiness").
    w.__VIZDIFF_STORY_READY__ = false

    const EVENT_TYPES = [
      // Success
      "storyRendered",
      "docsRendered",
      // Failure
      "storyErrored",
      "storyThrewException",
      "playFunctionThrewException",
      "storyMissing",
    ]

    const attach = (channel: any): void => {
      if (state.hooked || !channel || typeof channel.on !== "function") {
        return
      }
      for (const type of EVENT_TYPES) {
        channel.on(type, (arg: any) => {
          // Storybook emits either a story id string, an Error, or an object with
          // id/storyId/title/description depending on the event; record what we can.
          let storyId: string | undefined
          let message: string | undefined
          if (typeof arg === "string") {
            storyId = arg
          } else if (arg && typeof arg === "object") {
            if (typeof arg.id === "string") storyId = arg.id
            else if (typeof arg.storyId === "string") storyId = arg.storyId
            if (typeof arg.message === "string") message = arg.message
            else if (typeof arg.description === "string") message = arg.description
            else if (arg.error && typeof arg.error.message === "string") message = arg.error.message
          }
          state.events.push({ type, storyId, message })
        })
      }
      state.hooked = true
    }

    // Poll fallback: attach as soon as the channel global appears, for up to 30 s.
    const pollForChannel = (): void => {
      const start = Date.now()
      const timer = setInterval(() => {
        attach(w.__STORYBOOK_ADDONS_CHANNEL__)
        if (state.hooked || Date.now() - start > 30_000) {
          clearInterval(timer)
        }
      }, 50)
    }

    // Preferred path: intercept the channel assignment so listeners attach the moment Storybook
    // creates the channel (before any lifecycle event can fire).
    if ("__STORYBOOK_ADDONS_CHANNEL__" in w) {
      // Property already exists (unexpected for an init script, but possible if another init
      // script or an early page script defined it): attach to the current value or poll.
      attach(w.__STORYBOOK_ADDONS_CHANNEL__)
      if (!state.hooked) {
        pollForChannel()
      }
    } else {
      try {
        let channelValue: any = undefined
        Object.defineProperty(w, "__STORYBOOK_ADDONS_CHANNEL__", {
          configurable: true,
          set(value: any) {
            channelValue = value
            attach(value)
          },
          get() {
            return channelValue
          },
        })
      } catch {
        pollForChannel()
      }
    }
  } catch {
    // Never let hook installation crash the page.
  }
  /* eslint-enable */
}

/**
 * Installs the render-state hook on the given browser session. Must be called once after the
 * session is created and before navigating to any story.
 *
 * Uses WebDriver BiDi `addInitScript` so the hook is re-applied on every document/navigation for
 * the life of the session (mirrors `installBrowserSafeguards`).
 */
export async function installStoryRenderStateHook(browser: Browser): Promise<void> {
  try {
    await browser.addInitScript(renderStateInitScript)
    log.info("Installed story render-state hook (init script)")
  } catch (err) {
    // BiDi may be unavailable depending on the driver. Surface a warning but do not fail
    // rendering — waitForStoryReady degrades to the legacy fixed-delay behavior.
    log.warn(err, "Failed to install story render-state hook via init script")
  }
}

/** Warn only once per process when readiness degrades to the legacy fixed-delay behavior. */
let warnedDegradedReadiness = false

/** How long to wait for any readiness signal before degrading to the legacy behavior. */
const DEGRADED_FALLBACK_MS = 5 * 1000

/** The legacy post-load settle delay, used only on the degraded fallback path. */
const LEGACY_SETTLE_DELAY_MS = 500

/**
 * Waits for the current story's render lifecycle to complete before screenshot capture begins.
 *
 * Success is either a `storyRendered`/`docsRendered` channel event (recorded by
 * {@link renderStateInitScript}) or the SB8 `__STORYBOOK_PREVIEW__.currentRender.phase` reaching
 * `"completed"`. A failure event or an `"errored"` phase throws {@link StoryRenderError}
 * immediately; never completing throws {@link StoryRenderTimeoutError}.
 *
 * After render completion:
 *  - Stories opting into the ready-signal convention (`parameters.useReadySignal`,
 *    `parameters.vizdiff.waitForReady`, or `parameters.storyReady`) are additionally awaited via
 *    `window.__VIZDIFF_STORY_READY__ === true` within the remaining time budget.
 *  - An opt-in minimum delay (`parameters.vizdiff.delay`, falling back to
 *    `parameters.chromatic.delay`) is honored, clamped to `delayCapMs`.
 *
 * Graceful degradation: if the page produces no readiness signals at all for 5 s (preview booted
 * but no channel hook, no `currentRender`, and zero events — e.g. a very old Storybook or a driver
 * without BiDi init scripts), this returns after the legacy 500 ms settle delay instead of failing
 * the story, warning once per process.
 *
 * TASK: Use WebDriver BiDi to additionally wait for "network quiescence" (in-flight fonts/images/
 * fetches settling) after render completion, as Chromatic does.
 *
 * @param browser The WebDriverIO browser session, already navigated to the story URL
 * @param story The story being captured (id + parameters)
 * @param opts Timeout overrides, primarily for tests
 */
export async function waitForStoryReady(
  browser: Browser,
  story: Story,
  opts: { timeoutMs?: number; delayCapMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? WORKER_STORY_RENDER_TIMEOUT_MS
  const delayCapMs = opts.delayCapMs ?? WORKER_STORY_DELAY_MAX_MS
  const storyId = story.id
  const startTime = Date.now()

  let outcome: "rendered" | "degraded" | undefined
  let failure: StoryRenderEvent | undefined

  const timeoutMsg = `Story ${storyId} did not finish rendering within ${timeoutMs}ms`
  try {
    await browser.waitUntil(
      async () => {
        // eslint-disable-next-line prefer-arrow-callback
        const snapshot = await browser.execute(function () {
          // @ts-expect-error: window is not defined
          const w = window as StorybookWindow & RenderStateWindow
          // eslint-disable-next-line no-underscore-dangle
          const preview = w.__STORYBOOK_PREVIEW__
          // eslint-disable-next-line no-underscore-dangle
          const state = w.__VIZDIFF_RENDER_STATE__
          return {
            previewExists: !!preview,
            phase: preview?.currentRender?.phase,
            currentStoryId: preview?.currentRender?.id,
            events: state?.events ?? [],
            channelHooked: state?.hooked ?? false,
          }
        })

        // A failure event or an errored render phase fails the story immediately (the loading
        // fallback must never be captured as the story's screenshot).
        const failureEvent = snapshot.events.find((event) => FAILURE_EVENT_TYPES.has(event.type))
        if (failureEvent) {
          failure = failureEvent
          return true
        }
        if (snapshot.phase === "errored") {
          failure = { type: "errored-phase" }
          return true
        }

        const succeeded =
          snapshot.events.some((event) => SUCCESS_EVENT_TYPES.has(event.type)) ||
          snapshot.phase === "completed"
        if (succeeded) {
          outcome = "rendered"
          return true
        }

        // Graceful degradation: the preview booted but nothing is reporting render state (no
        // channel hook, no currentRender, no events). Proceed legacy-style rather than failing
        // every story on Storybooks/drivers that predate these signals.
        if (
          snapshot.previewExists &&
          !snapshot.channelHooked &&
          snapshot.phase == undefined &&
          snapshot.events.length === 0 &&
          Date.now() - startTime >= DEGRADED_FALLBACK_MS
        ) {
          outcome = "degraded"
          return true
        }

        return false
      },
      { timeout: timeoutMs, timeoutMsg, interval: 100 },
    )
  } catch (err) {
    // waitUntil timed out without any terminal signal.
    if (err instanceof Error && err.message.includes(timeoutMsg)) {
      throw new StoryRenderTimeoutError(storyId, timeoutMs, "render")
    }
    throw err
  }

  if (failure) {
    throw new StoryRenderError(
      storyId,
      failure.message ??
        (failure.type === "errored-phase" ? 'render phase "errored"' : failure.type),
    )
  }

  if (outcome === "degraded") {
    if (!warnedDegradedReadiness) {
      warnedDegradedReadiness = true
      log.warn(
        `No story render-state signals detected for story ${storyId} (old Storybook or init ` +
          `script unavailable); degrading to the legacy fixed ${LEGACY_SETTLE_DELAY_MS}ms delay. ` +
          `Warning once per process.`,
      )
    }
    await browser.pause(LEGACY_SETTLE_DELAY_MS)
    return
  }

  // Ready-signal convention (Chromatic-era `useReadySignal` storybooks): the story resolves an
  // explicit signal once its async scene is actually drawn. A bridge decorator sets
  // `window.__VIZDIFF_STORY_READY__ = true` (see docs/CONFIGURATION.md "Story readiness").
  const parameters = story.parameters
  const wantsReadySignal =
    parameters?.useReadySignal === true ||
    parameters?.vizdiff?.waitForReady === true ||
    parameters?.storyReady === true
  if (wantsReadySignal) {
    const remainingMs = timeoutMs - (Date.now() - startTime)
    const readyTimeoutMsg = `Story ${storyId} ready signal not set within remaining budget`
    try {
      await browser.waitUntil(
        async () => {
          // eslint-disable-next-line prefer-arrow-callback
          return await browser.execute(function () {
            // @ts-expect-error: window is not defined
            // eslint-disable-next-line no-underscore-dangle
            return (window as RenderStateWindow).__VIZDIFF_STORY_READY__ === true
          })
        },
        { timeout: Math.max(remainingMs, 0), timeoutMsg: readyTimeoutMsg, interval: 100 },
      )
    } catch (err) {
      if (err instanceof Error && err.message.includes(readyTimeoutMsg)) {
        throw new StoryRenderTimeoutError(storyId, timeoutMs, "ready-signal")
      }
      throw err
    }
  }

  // Opt-in minimum delay before capture, clamped so an untrusted story parameter cannot stall the
  // build. `parameters.vizdiff.delay` wins over the Chromatic-compatible `parameters.chromatic.delay`.
  const rawDelay = parameters?.vizdiff?.delay ?? parameters?.chromatic?.delay ?? 0
  const delayMs = clampDelay(rawDelay, delayCapMs)
  if (delayMs !== rawDelay) {
    log.warn(
      `Story ${storyId} requested a pre-capture delay of ${rawDelay}ms; clamping to ${delayMs}ms ` +
        `(WORKER_STORY_DELAY_MAX_MS)`,
    )
  }
  if (delayMs > 0) {
    log.debug(`Pausing ${delayMs}ms before capture for story ${storyId} (per-story delay)`)
    await browser.pause(delayMs)
  }
}

/** Clamps a story-supplied delay to [0, capMs]; non-finite values are treated as 0. */
function clampDelay(value: number, capMs: number): number {
  if (typeof value !== "number" || isNaN(value) || !isFinite(value)) {
    return 0
  }
  return Math.min(Math.max(value, 0), capMs)
}
