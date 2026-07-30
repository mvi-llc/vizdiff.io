import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Browser } from "webdriverio"

import {
  installStoryRenderStateHook,
  renderStateInitScript,
  StoryRenderError,
  StoryRenderTimeoutError,
  waitForStoryReady,
  type VizdiffRenderState,
} from "./storyReady"
import { createMockBrowser } from "./testing/mockBrowser"
import type { Story } from "./types"

vi.mock("./log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const STORY_ID = "components-appbar-addpanelmenu--default"

function makeStory(parameters?: Story["parameters"]): Story {
  return {
    id: STORY_ID,
    kind: "components/AppBar/AddPanelMenu",
    name: "Default",
    title: "components/AppBar/AddPanelMenu",
    importPath: "./AddPanelMenu.stories.tsx",
    componentPath: "./AddPanelMenu.stories.tsx",
    tags: [],
    parameters,
  }
}

describe("waitForStoryReady", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("completes when the render phase progresses preparing -> rendering -> completed", async () => {
    const { browser, state } = createMockBrowser({ phase: "preparing" })
    const promise = waitForStoryReady(browser, makeStory())
    setTimeout(() => (state.phase = "rendering"), 200)
    setTimeout(() => (state.phase = "completed"), 400)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toBeUndefined()
  })

  it("completes on a storyRendered event even with no currentRender phase", async () => {
    const { browser } = createMockBrowser({
      phase: undefined,
      events: [{ type: "storyRendered", storyId: STORY_ID }],
    })
    await expect(waitForStoryReady(browser, makeStory())).resolves.toBeUndefined()
  })

  it("counts docsRendered as render completion", async () => {
    const { browser } = createMockBrowser({
      phase: undefined,
      events: [{ type: "docsRendered", storyId: STORY_ID }],
    })
    await expect(waitForStoryReady(browser, makeStory())).resolves.toBeUndefined()
  })

  it("throws StoryRenderError on a storyErrored event, well before the timeout", async () => {
    const { browser } = createMockBrowser({
      phase: undefined,
      events: [{ type: "storyErrored", storyId: STORY_ID, message: "boom" }],
    })
    const start = Date.now()
    const err: unknown = await waitForStoryReady(browser, makeStory()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoryRenderError)
    expect((err as Error).message).toContain("boom")
    // Failed immediately on the first poll, not at the render timeout.
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('throws StoryRenderError when the render phase is "errored"', async () => {
    const { browser } = createMockBrowser({ phase: "errored" })
    await expect(waitForStoryReady(browser, makeStory())).rejects.toThrow(StoryRenderError)
  })

  it('throws StoryRenderTimeoutError with reason "render" when the story never completes', async () => {
    const { browser } = createMockBrowser({ phase: "rendering" })
    const errPromise = waitForStoryReady(browser, makeStory(), { timeoutMs: 3000 }).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(4000)
    const err = await errPromise
    expect(err).toBeInstanceOf(StoryRenderTimeoutError)
    expect((err as StoryRenderTimeoutError).reason).toBe("render")
  })

  it("honors parameters.vizdiff.delay after render completion", async () => {
    const { browser, fns } = createMockBrowser()
    await expect(
      waitForStoryReady(browser, makeStory({ vizdiff: { delay: 2000 } })),
    ).resolves.toBeUndefined()
    expect(fns.pause).toHaveBeenCalledWith(2000)
  })

  it("falls back to parameters.chromatic.delay when vizdiff.delay is unset", async () => {
    const { browser, fns } = createMockBrowser()
    await expect(
      waitForStoryReady(browser, makeStory({ chromatic: { delay: 1500 } })),
    ).resolves.toBeUndefined()
    expect(fns.pause).toHaveBeenCalledWith(1500)
  })

  it("clamps the per-story delay to the delay cap", async () => {
    const { browser, fns } = createMockBrowser()
    await expect(
      waitForStoryReady(browser, makeStory({ vizdiff: { delay: 60_000 } }), { delayCapMs: 1000 }),
    ).resolves.toBeUndefined()
    expect(fns.pause).toHaveBeenCalledWith(1000)
    expect(fns.pause).not.toHaveBeenCalledWith(60_000)
  })

  it("waits for the ready-signal global when parameters.useReadySignal is set", async () => {
    const { browser, state } = createMockBrowser()
    const promise = waitForStoryReady(browser, makeStory({ useReadySignal: true }))
    setTimeout(() => (state.storyReady = true), 300)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toBeUndefined()
  })

  it('times out with reason "ready-signal" when the opted-in signal never resolves', async () => {
    const { browser } = createMockBrowser()
    const errPromise = waitForStoryReady(browser, makeStory({ vizdiff: { waitForReady: true } }), {
      timeoutMs: 2000,
    }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(3000)
    const err = await errPromise
    expect(err).toBeInstanceOf(StoryRenderTimeoutError)
    expect((err as StoryRenderTimeoutError).reason).toBe("ready-signal")
  })

  it("degrades to the legacy fixed delay when no render-state signals appear for 5s", async () => {
    // Preview booted, but no channel hook, no currentRender, and zero events (e.g. a very old
    // Storybook or a driver without BiDi init scripts).
    const { browser, state, fns } = createMockBrowser({ phase: undefined, channelHooked: false })
    state.events = []
    const promise = waitForStoryReady(browser, makeStory())
    await vi.advanceTimersByTimeAsync(6000)
    await expect(promise).resolves.toBeUndefined()
    expect(fns.pause).toHaveBeenCalledWith(500)
  })
})

describe("installStoryRenderStateHook", () => {
  it("installs the init script via addInitScript", async () => {
    const addInitScript = vi.fn().mockResolvedValue(undefined)
    const browser = { addInitScript } as unknown as Browser
    await installStoryRenderStateHook(browser)
    expect(addInitScript).toHaveBeenCalledWith(renderStateInitScript)
  })

  it("does not throw if addInitScript fails (BiDi unavailable)", async () => {
    const addInitScript = vi.fn().mockRejectedValue(new Error("no BiDi"))
    const browser = { addInitScript } as unknown as Browser
    await expect(installStoryRenderStateHook(browser)).resolves.toBeUndefined()
  })
})

/**
 * Exercises the page init script against a minimal fake `window`, simulating the browser
 * environment so we can assert the runtime hook behavior without a real browser (same technique
 * as safeguards.test.ts).
 */
describe("renderStateInitScript (page behavior)", () => {
  type Handler = (arg?: unknown) => void

  function makeChannel() {
    const handlers = new Map<string, Handler[]>()
    const channel = {
      on: (type: string, fn: Handler) => {
        handlers.set(type, [...(handlers.get(type) ?? []), fn])
      },
    }
    const emit = (type: string, arg?: unknown) => {
      for (const fn of handlers.get(type) ?? []) {
        fn(arg)
      }
    }
    return { channel, emit, handlers }
  }

  function run(win: Record<string, unknown>) {
    const g = globalThis as unknown as { window?: unknown }
    const prev = g.window
    g.window = win
    try {
      renderStateInitScript()
    } finally {
      if (prev == undefined) {
        delete g.window
      } else {
        g.window = prev
      }
    }
  }

  function stateOf(win: Record<string, unknown>): VizdiffRenderState {
    // eslint-disable-next-line no-underscore-dangle
    return win.__VIZDIFF_RENDER_STATE__ as VizdiffRenderState
  }

  it("initializes the render state and ready-signal globals", () => {
    const win: Record<string, unknown> = {}
    run(win)
    expect(stateOf(win)).toEqual({ events: [], hooked: false })
    // eslint-disable-next-line no-underscore-dangle
    expect(win.__VIZDIFF_STORY_READY__).toBe(false)
  })

  it("attaches listeners when Storybook assigns the channel and records lifecycle events", () => {
    const win: Record<string, unknown> = {}
    run(win)
    const { channel, emit } = makeChannel()
    // Storybook boots and assigns the channel global; the accessor hook attaches listeners.
    // eslint-disable-next-line no-underscore-dangle
    win.__STORYBOOK_ADDONS_CHANNEL__ = channel
    // eslint-disable-next-line no-underscore-dangle
    expect(win.__STORYBOOK_ADDONS_CHANNEL__).toBe(channel)
    expect(stateOf(win).hooked).toBe(true)

    emit("storyRendered", STORY_ID)
    emit("storyThrewException", new Error("kaboom"))
    expect(stateOf(win).events).toEqual([
      { type: "storyRendered", storyId: STORY_ID, message: undefined },
      { type: "storyThrewException", storyId: undefined, message: "kaboom" },
    ])
  })

  it("falls back to polling when the channel global already exists", async () => {
    vi.useFakeTimers()
    try {
      // Property predefined (so defineProperty interception is skipped) but with no channel yet.
      const win: Record<string, unknown> = { __STORYBOOK_ADDONS_CHANNEL__: undefined }
      run(win)
      expect(stateOf(win).hooked).toBe(false)

      const { channel, emit } = makeChannel()
      // eslint-disable-next-line no-underscore-dangle
      win.__STORYBOOK_ADDONS_CHANNEL__ = channel
      await vi.advanceTimersByTimeAsync(100)
      expect(stateOf(win).hooked).toBe(true)

      emit("docsRendered", STORY_ID)
      expect(stateOf(win).events).toEqual([
        { type: "docsRendered", storyId: STORY_ID, message: undefined },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
