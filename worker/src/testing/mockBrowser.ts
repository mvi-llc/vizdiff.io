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
  }
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
    isMultiremote: false,
    capabilities: {},
    sessionId: "mock-session",
    options: {},
  } as unknown as Browser

  return {
    browser,
    state,
    fns: { url, execute, saveScreenshot, setViewport, pause, waitUntil, addInitScript },
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
    __VIZDIFF_RENDER_STATE__: { events: state.events, hooked: state.channelHooked },
    __VIZDIFF_STORY_READY__: state.storyReady,
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
