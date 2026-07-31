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
    await expect(promise).resolves.toMatchObject({ outcome: "rendered" })
  })

  it("completes on a storyRendered event even with no currentRender phase", async () => {
    const { browser } = createMockBrowser({
      phase: undefined,
      events: [{ type: "storyRendered", storyId: STORY_ID }],
    })
    await expect(waitForStoryReady(browser, makeStory())).resolves.toMatchObject({
      outcome: "rendered",
    })
  })

  it("counts docsRendered as render completion", async () => {
    const { browser } = createMockBrowser({
      phase: undefined,
      events: [{ type: "docsRendered", storyId: STORY_ID }],
    })
    await expect(waitForStoryReady(browser, makeStory())).resolves.toMatchObject({
      outcome: "rendered",
    })
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
    ).resolves.toMatchObject({ outcome: "rendered" })
    expect(fns.pause).toHaveBeenCalledWith(2000)
  })

  it("falls back to parameters.chromatic.delay when vizdiff.delay is unset", async () => {
    const { browser, fns } = createMockBrowser()
    await expect(
      waitForStoryReady(browser, makeStory({ chromatic: { delay: 1500 } })),
    ).resolves.toMatchObject({ outcome: "rendered" })
    expect(fns.pause).toHaveBeenCalledWith(1500)
  })

  it("clamps the per-story delay to the delay cap", async () => {
    const { browser, fns } = createMockBrowser()
    await expect(
      waitForStoryReady(browser, makeStory({ vizdiff: { delay: 60_000 } }), { delayCapMs: 1000 }),
    ).resolves.toMatchObject({ outcome: "rendered" })
    expect(fns.pause).toHaveBeenCalledWith(1000)
    expect(fns.pause).not.toHaveBeenCalledWith(60_000)
  })

  it("waits for the ready-signal global when parameters.useReadySignal is set", async () => {
    const { browser, state } = createMockBrowser()
    const promise = waitForStoryReady(browser, makeStory({ useReadySignal: true }))
    setTimeout(() => (state.storyReady = true), 300)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(promise).resolves.toMatchObject({ outcome: "rendered" })
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
    const result = await promise
    expect(result.outcome).toBe("degraded")
    // No batched content height on the degraded path (issue #474): capture must fall back to its
    // own authoritative measurement.
    expect(result.contentHeight).toBeUndefined()
    expect(fns.pause).toHaveBeenCalledWith(500)
  })

  it("returns the content height measured on the readiness snapshot (#474)", async () => {
    const { browser } = createMockBrowser({ contentHeight: 1234 })
    await expect(waitForStoryReady(browser, makeStory())).resolves.toEqual({
      outcome: "rendered",
      contentHeight: 1234,
    })
  })

  /**
   * Story-scoped readiness for in-place switching (issue #474): after a soft switch the document
   * is reused, so `currentRender` can still describe the PREVIOUS story for a beat. Soft mode
   * must not trust a stale phase; both modes scope success events to the story id.
   */
  describe("soft/hard navigation modes (#474)", () => {
    it("soft mode rejects a stale completed phase from the previous story, then succeeds on the fresh event", async () => {
      const { browser, state } = createMockBrowser({
        phase: "completed",
        currentStoryId: "previous-story--stale",
      })
      const promise = waitForStoryReady(browser, makeStory(), { mode: "soft" })
      setTimeout(() => state.events.push({ type: "storyRendered", storyId: STORY_ID }), 300)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(promise).resolves.toMatchObject({ outcome: "rendered" })
    })

    it("soft mode accepts a completed phase once currentRender points at this story", async () => {
      const { browser, state } = createMockBrowser({
        phase: "completed",
        currentStoryId: "previous-story--stale",
      })
      const promise = waitForStoryReady(browser, makeStory(), { mode: "soft" })
      setTimeout(() => (state.currentStoryId = STORY_ID), 300)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(promise).resolves.toMatchObject({ outcome: "rendered" })
    })

    it("ignores a success event carrying a different story id", async () => {
      const { browser } = createMockBrowser({
        phase: "rendering",
        events: [{ type: "storyRendered", storyId: "some-other--story" }],
      })
      const errPromise = waitForStoryReady(browser, makeStory(), { timeoutMs: 2000 }).catch(
        (e: unknown) => e,
      )
      await vi.advanceTimersByTimeAsync(3000)
      expect(await errPromise).toBeInstanceOf(StoryRenderTimeoutError)
    })

    it("accepts a success event with a matching story id in soft mode", async () => {
      const { browser } = createMockBrowser({
        phase: undefined,
        events: [{ type: "storyRendered", storyId: STORY_ID }],
      })
      await expect(
        waitForStoryReady(browser, makeStory(), { mode: "soft" }),
      ).resolves.toMatchObject({ outcome: "rendered" })
    })

    it("accepts a success event with no story id (older Storybook event payloads)", async () => {
      const { browser } = createMockBrowser({
        phase: undefined,
        events: [{ type: "storyRendered" }],
      })
      await expect(
        waitForStoryReady(browser, makeStory(), { mode: "soft" }),
      ).resolves.toMatchObject({ outcome: "rendered" })
    })

    it("fails on a storyId-less failure event (events are generation-scoped)", async () => {
      const { browser } = createMockBrowser({
        phase: undefined,
        events: [{ type: "storyThrewException", message: "boom after the switch" }],
      })
      await expect(waitForStoryReady(browser, makeStory(), { mode: "soft" })).rejects.toThrow(
        StoryRenderError,
      )
    })

    it("soft mode ignores an errored phase attributed to a different story", async () => {
      const { browser, state } = createMockBrowser({
        phase: "errored",
        currentStoryId: "some-other--story",
      })
      const promise = waitForStoryReady(browser, makeStory(), { mode: "soft" })
      setTimeout(() => state.events.push({ type: "storyRendered", storyId: STORY_ID }), 300)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(promise).resolves.toMatchObject({ outcome: "rendered" })
    })

    it("soft mode fails on an errored phase attributed to this story", async () => {
      const { browser } = createMockBrowser({ phase: "errored", currentStoryId: STORY_ID })
      await expect(waitForStoryReady(browser, makeStory(), { mode: "soft" })).rejects.toThrow(
        StoryRenderError,
      )
    })

    it("hard mode still accepts a completed phase with no currentRender id (back-compat)", async () => {
      const { browser } = createMockBrowser({ phase: "completed", currentStoryId: undefined })
      await expect(
        waitForStoryReady(browser, makeStory(), { mode: "hard" }),
      ).resolves.toMatchObject({ outcome: "rendered" })
    })

    it("hard mode requires the phase's currentRender id to match when it is defined", async () => {
      const { browser } = createMockBrowser({
        phase: "completed",
        currentStoryId: "some-other--story",
      })
      const errPromise = waitForStoryReady(browser, makeStory(), { timeoutMs: 2000 }).catch(
        (e: unknown) => e,
      )
      await vi.advanceTimersByTimeAsync(3000)
      expect(await errPromise).toBeInstanceOf(StoryRenderTimeoutError)
    })

    it("does not degrade to the legacy delay in soft mode", async () => {
      // Signal-less page: hard mode would degrade after 5s, but a soft switch is only entered
      // when the channel was hooked, so soft mode must keep waiting until the timeout.
      const { browser, state } = createMockBrowser({ phase: undefined, channelHooked: false })
      state.events = []
      const errPromise = waitForStoryReady(browser, makeStory(), {
        mode: "soft",
        timeoutMs: 8000,
      }).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await errPromise).toBeInstanceOf(StoryRenderTimeoutError)
    })
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
    /** Payloads emitted ON the channel (e.g. via __VIZDIFF_EMIT__, issue #474). */
    const emitted: Array<{ type: string; payload?: unknown }> = []
    const channel = {
      on: (type: string, fn: Handler) => {
        handlers.set(type, [...(handlers.get(type) ?? []), fn])
      },
      emit: (type: string, payload?: unknown) => {
        emitted.push({ type, payload })
        for (const fn of handlers.get(type) ?? []) {
          fn(payload)
        }
      },
    }
    const emit = (type: string, arg?: unknown) => {
      for (const fn of handlers.get(type) ?? []) {
        fn(arg)
      }
    }
    return { channel, emit, emitted, handlers }
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
    expect(stateOf(win)).toMatchObject({
      events: [],
      hooked: false,
      generation: 0,
      currentStoryId: undefined,
      channel: undefined,
    })
    expect(typeof stateOf(win).reset).toBe("function")
    // eslint-disable-next-line no-underscore-dangle
    expect(win.__VIZDIFF_STORY_READY__).toBe(false)
    // eslint-disable-next-line no-underscore-dangle
    expect(typeof win.__VIZDIFF_EMIT__).toBe("function")
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

  it("reset clears events, bumps the generation, and re-arms the ready signal (#474)", () => {
    const win: Record<string, unknown> = {}
    run(win)
    const { channel, emit } = makeChannel()
    // eslint-disable-next-line no-underscore-dangle
    win.__STORYBOOK_ADDONS_CHANNEL__ = channel
    emit("storyRendered", "previous--story")
    // eslint-disable-next-line no-underscore-dangle
    win.__VIZDIFF_STORY_READY__ = true

    stateOf(win).reset("next--story")

    expect(stateOf(win).events).toEqual([])
    expect(stateOf(win).generation).toBe(1)
    expect(stateOf(win).currentStoryId).toBe("next--story")
    // eslint-disable-next-line no-underscore-dangle
    expect(win.__VIZDIFF_STORY_READY__).toBe(false)
    // The channel hook survives a reset: subsequent lifecycle events are still recorded.
    emit("storyRendered", "next--story")
    expect(stateOf(win).events).toEqual([
      { type: "storyRendered", storyId: "next--story", message: undefined },
    ])
  })

  it("__VIZDIFF_EMIT__ returns false pre-channel and delivers post-attach (defineProperty path)", () => {
    const win: Record<string, unknown> = {}
    run(win)
    // eslint-disable-next-line no-underscore-dangle
    const emitFn = win.__VIZDIFF_EMIT__ as (type: string, payload?: unknown) => boolean
    expect(emitFn("setCurrentStory", { storyId: "x--y" })).toBe(false)

    const { channel, emitted } = makeChannel()
    // eslint-disable-next-line no-underscore-dangle
    win.__STORYBOOK_ADDONS_CHANNEL__ = channel

    expect(emitFn("setCurrentStory", { storyId: "x--y", viewMode: "story" })).toBe(true)
    expect(emitted).toEqual([
      { type: "setCurrentStory", payload: { storyId: "x--y", viewMode: "story" } },
    ])
  })

  it("__VIZDIFF_EMIT__ returns false pre-channel and delivers post-attach (poll path)", async () => {
    vi.useFakeTimers()
    try {
      const win: Record<string, unknown> = { __STORYBOOK_ADDONS_CHANNEL__: undefined }
      run(win)
      // eslint-disable-next-line no-underscore-dangle
      const emitFn = win.__VIZDIFF_EMIT__ as (type: string, payload?: unknown) => boolean
      expect(emitFn("setCurrentStory", { storyId: "x--y" })).toBe(false)

      const { channel, emitted } = makeChannel()
      // eslint-disable-next-line no-underscore-dangle
      win.__STORYBOOK_ADDONS_CHANNEL__ = channel
      await vi.advanceTimersByTimeAsync(100)

      expect(emitFn("setCurrentStory", { storyId: "x--y" })).toBe(true)
      expect(emitted).toEqual([{ type: "setCurrentStory", payload: { storyId: "x--y" } }])
    } finally {
      vi.useRealTimers()
    }
  })
})
