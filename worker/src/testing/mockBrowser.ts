import { vi } from "vitest"
import type { Browser } from "webdriverio"

import type { StoryRenderEvent } from "../storyReady"

/**
 * Shared WebdriverIO browser mock for worker tests.
 *
 * Unlike an always-true `waitUntil` stub, this mock ACTUALLY polls the predicate honoring the
 * `timeout`/`interval` options (compatible with vitest fake timers: the wait between polls is a
 * `setTimeout`, and timeout tracking uses `Date.now()`, both of which fake timers control).
 *
 * `execute` runs the passed page function for real against a fake `window`/`document` built from
 * a mutable {@link MockPageState} — tests mutate the returned `state` object (including mid-poll,
 * via `setTimeout` under fake timers) to script what the "page" reports. This keeps tests robust
 * to the number and order of `execute` calls instead of relying on positional
 * `mockResolvedValueOnce` chains.
 */

/** Mutable scripted page state backing the fake `window`/`document` seen by `execute`. */
export interface MockPageState {
  /** Whether `window.__STORYBOOK_PREVIEW__` exists. */
  previewExists: boolean
  /** `__STORYBOOK_PREVIEW__.currentRender.phase`; undefined = no currentRender. */
  phase: string | undefined
  /** `__STORYBOOK_PREVIEW__.currentRender.id`. */
  currentStoryId: string | undefined
  /** Events recorded by the render-state init script (`__VIZDIFF_RENDER_STATE__.events`). */
  events: StoryRenderEvent[]
  /** `__VIZDIFF_RENDER_STATE__.hooked`. */
  channelHooked: boolean
  /** `window.__VIZDIFF_STORY_READY__`. */
  storyReady: boolean
  /**
   * `document.body/documentElement.scrollHeight`. A number is returned for every measurement; an
   * array is consumed one element per `execute` call that reads it (the last element sticks),
   * which lets a test script "layout not settled yet, then tall" sequences.
   */
  contentHeight: number | number[] | undefined
  /**
   * Whether the fake page has a hooked preview channel: `window.__VIZDIFF_EMIT__` returns true
   * (and records the emit) when set, false when not (issue #474 in-place switching).
   */
  channelPresent: boolean
  /** Emits recorded by the fake `__VIZDIFF_EMIT__` (issue #474 in-place switching). */
  emitted: Array<{ type: string; payload: unknown }>
  /**
   * Scripted channel behavior, called after each successful `__VIZDIFF_EMIT__`. The default
   * ({@link respondToSetCurrentStory}) reacts to `setCurrentStory` like a healthy Storybook:
   * records a `storyRendered` event and points phase/currentStoryId at the target story. Replace
   * it to script sick channels (errors, silence), or set undefined for an unresponsive one.
   */
  onEmit?: (state: MockPageState, type: string, payload: unknown) => void
  /** URLs passed to `history.replaceState` by page functions under test (issue #474). */
  replaceStateCalls: string[]
}

/**
 * Default `onEmit`: behaves like a healthy Storybook preview receiving `setCurrentStory` — the
 * story renders instantly, emitting `storyRendered` and completing the render phase.
 */
export function respondToSetCurrentStory(
  state: MockPageState,
  type: string,
  payload: unknown,
): void {
  if (type !== "setCurrentStory") {
    return
  }
  const storyId = (payload as { storyId?: string }).storyId
  state.events.push({ type: "storyRendered", storyId })
  state.phase = "completed"
  state.currentStoryId = storyId
}

/** Default state: the current story completed rendering immediately. */
export function defaultMockPageState(): MockPageState {
  return {
    previewExists: true,
    phase: "completed",
    currentStoryId: undefined,
    events: [],
    channelHooked: true,
    storyReady: false,
    contentHeight: undefined,
    channelPresent: true,
    emitted: [],
    onEmit: respondToSetCurrentStory,
    replaceStateCalls: [],
  }
}

export interface MockBrowserResult {
  browser: Browser
  /** Mutate freely (mid-test or mid-poll) to change what the fake page reports. */
  state: MockPageState
  /** The underlying vi.fn mocks, for call assertions and per-test overrides. */
  fns: {
    url: ReturnType<typeof vi.fn>
    execute: ReturnType<typeof vi.fn>
    saveScreenshot: ReturnType<typeof vi.fn>
    setViewport: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    waitUntil: ReturnType<typeof vi.fn>
    addInitScript: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    sessionSubscribe: ReturnType<typeof vi.fn>
    takeScreenshot: ReturnType<typeof vi.fn>
  }
  /**
   * Delivers a fake BiDi event payload to every handler registered via `browser.on(event, ...)`,
   * letting tests drive log/network subscriptions (issue #475 session diagnostics).
   */
  emitBidi: (event: string, payload: unknown) => void
}

/**
 * Creates the mock browser. `initial` overrides {@link defaultMockPageState}; the same `state`
 * object is live for the life of the mock, so tests can flip fields between (or during) polls.
 */
export function createMockBrowser(initial: Partial<MockPageState> = {}): MockBrowserResult {
  const state: MockPageState = { ...defaultMockPageState(), ...initial }

  const url = vi.fn().mockResolvedValue(undefined)
  const setViewport = vi.fn().mockResolvedValue(undefined)
  const addInitScript = vi.fn().mockResolvedValue(undefined)
  // Immediate no-op: production code paces itself with pause(), but tests only assert the calls.
  const pause = vi.fn().mockResolvedValue(undefined)
  const saveScreenshot = vi.fn(async () => Buffer.from("mock screenshot data"))

  const execute = vi.fn(async (script: unknown, ...args: unknown[]) => {
    if (typeof script !== "function") {
      throw new Error("mock execute only supports function scripts")
    }
    return await runInFakePage(script as (...a: unknown[]) => unknown, args, state)
  })

  // BiDi event plumbing (issue #475): `on` records handlers per event name; `emitBidi` (on the
  // returned result) synchronously delivers a payload to them.
  const bidiHandlers = new Map<string, Array<(payload: unknown) => void>>()
  const on = vi.fn((event: string, handler: (payload: unknown) => void) => {
    const handlers = bidiHandlers.get(event) ?? []
    handlers.push(handler)
    bidiHandlers.set(event, handlers)
    return browser
  })
  const sessionSubscribe = vi.fn().mockResolvedValue(undefined)
  // Real takeScreenshot resolves a base64-encoded PNG string.
  const takeScreenshot = vi.fn(async () =>
    Buffer.from("mock failure screenshot data").toString("base64"),
  )
  const emitBidi = (event: string, payload: unknown): void => {
    for (const handler of bidiHandlers.get(event) ?? []) {
      handler(payload)
    }
  }

  const waitUntil = vi.fn(
    async (
      condition: () => unknown,
      options?: { timeout?: number; interval?: number; timeoutMsg?: string },
    ) => {
      const timeout = options?.timeout ?? 5000
      const interval = options?.interval ?? 100
      const start = Date.now()
      for (;;) {
        const result = await condition()
        if (result) {
          return result
        }
        if (Date.now() - start >= timeout) {
          throw new Error(options?.timeoutMsg ?? `waitUntil condition timed out after ${timeout}ms`)
        }
        // Real wait between polls so vitest fake timers control the pacing.
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    },
  )

  const browser = {
    url,
    execute,
    saveScreenshot,
    setViewport,
    pause,
    waitUntil,
    addInitScript,
    on,
    sessionSubscribe,
    takeScreenshot,
    isMultiremote: false,
    capabilities: {},
    sessionId: "mock-session",
    options: {},
  } as unknown as Browser

  return {
    browser,
    state,
    fns: {
      url,
      execute,
      saveScreenshot,
      setViewport,
      pause,
      waitUntil,
      addInitScript,
      on,
      sessionSubscribe,
      takeScreenshot,
    },
    emitBidi,
  }
}

/**
 * Runs a page function against a fake `window`/`document` derived from `state`, temporarily
 * installed as globals (the same technique safeguards.test.ts uses for the init script).
 */
async function runInFakePage(
  script: (...args: unknown[]) => unknown,
  args: unknown[],
  state: MockPageState,
): Promise<unknown> {
  const win = buildFakeWindow(state)
  const doc = buildFakeDocument(state)
  const g = globalThis as unknown as { window?: unknown; document?: unknown }
  const prevWindow = g.window
  const prevDocument = g.document
  g.window = win
  g.document = doc
  try {
    return await script(...args)
  } finally {
    if (prevWindow == undefined) {
      delete g.window
    } else {
      g.window = prevWindow
    }
    if (prevDocument == undefined) {
      delete g.document
    } else {
      g.document = prevDocument
    }
  }
}

function buildFakeWindow(state: MockPageState): Record<string, unknown> {
  const preview = state.previewExists
    ? {
        ready: true,
        currentRender:
          state.phase != undefined || state.currentStoryId != undefined
            ? { id: state.currentStoryId, phase: state.phase }
            : undefined,
        storyStore: { cacheAllCSFFiles: async () => undefined },
        extract: async () => ({}),
      }
    : undefined
  return {
    __STORYBOOK_PREVIEW__: preview,
    __VIZDIFF_RENDER_STATE__: {
      events: state.events,
      hooked: state.channelHooked,
      generation: 0,
      currentStoryId: undefined,
      // Fake of the init script's re-arm hook (issue #474): clears recorded events (in place, so
      // the state.events identity survives) and the ready signal.
      reset: (_storyId: string): void => {
        state.events.length = 0
        state.storyReady = false
      },
    },
    __VIZDIFF_EMIT__: (type: string, payload: unknown): boolean => {
      if (!state.channelPresent) {
        return false
      }
      state.emitted.push({ type, payload })
      state.onEmit?.(state, type, payload)
      return true
    },
    history: {
      replaceState: (_data: unknown, _unused: string, url: string): void => {
        state.replaceStateCalls.push(url)
      },
    },
    __VIZDIFF_STORY_READY__: state.storyReady,
    // Immediate callback so the rAF-spaced stabilization tick (issue #474) — an execute whose
    // page function awaits a requestAnimationFrame-chained promise — resolves without any timer
    // advancement (fake-timer compatible: no setTimeout involved).
    requestAnimationFrame: (callback: () => void): number => {
      callback()
      return 0
    },
  }
}

function buildFakeDocument(state: MockPageState): Record<string, unknown> {
  // Consume at most one contentHeight array element per execute call, regardless of how many
  // scrollHeight properties the page function reads.
  let consumed: number | undefined
  const readHeight = (): number => {
    consumed ??= nextContentHeight(state)
    return consumed
  }
  return {
    createElement: () => ({ textContent: "" }),
    head: { appendChild: () => undefined },
    body: {
      get scrollHeight() {
        return readHeight()
      },
    },
    documentElement: {
      get scrollHeight() {
        return readHeight()
      },
    },
  }
}

function nextContentHeight(state: MockPageState): number {
  const { contentHeight } = state
  if (contentHeight == undefined) {
    return 0
  }
  if (typeof contentHeight === "number") {
    return contentHeight
  }
  // Array: shift one element per measuring execute call; the last element sticks.
  const value = contentHeight.length > 1 ? contentHeight.shift() : contentHeight[0]
  return value ?? 0
}
