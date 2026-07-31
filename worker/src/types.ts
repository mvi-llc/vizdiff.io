export interface Viewport {
  name: string
  styles: ViewportStyles
  type: "desktop" | "mobile" | "tablet" | "other"
}

export interface ViewportStyles {
  height: string
  width: string
}

export type ViewportMap = Record<string, Viewport>

export interface ViewportsParam {
  defaultViewport?: string
  viewports?: ViewportMap
  options?: ViewportMap
  disable?: boolean
  disabled?: boolean
}

export interface StoryParameters {
  viewport?: ViewportsParam
  /** Chromatic-compatible per-story options; `delay` is a minimum pre-capture delay in ms. */
  chromatic?: { delay?: number }
  /** vizdiff-native per-story options (take precedence over the Chromatic equivalents). */
  vizdiff?: {
    /** Minimum pre-capture delay in ms (clamped to WORKER_STORY_DELAY_MAX_MS). */
    delay?: number
    /** Wait for `window.__VIZDIFF_STORY_READY__ === true` before capture (see storyReady.ts). */
    waitForReady?: boolean
    /**
     * Opt this story out of in-place story switching (issue #474): always load it via a full
     * page navigation, for stories known to leak global state that survives a soft switch.
     */
    forceNavigation?: boolean
  }
  /** Chromatic-era Foxglove convention: the story resolves an explicit ready signal. */
  useReadySignal?: boolean
  /** Alternate spelling of the ready-signal opt-in used by some storybooks. */
  storyReady?: boolean
}

export interface Story {
  id: string
  kind: string
  name: string
  title: string
  importPath: string
  componentPath: string
  tags: string[]

  // argTypes
  args?: Record<string, unknown>
  globals?: { viewport?: { value: string } }
  initialArgs?: Record<string, unknown>

  parameters?: StoryParameters
}

export interface SetViewportOptions {
  width: number
  height: number
  devicePixelRatio?: number
}

export type StorybookWindow = {
  __STORYBOOK_PREVIEW__?: {
    // Storybook 8 makes `ready` a Promise (or a method returning one), so a truthiness check is
    // NOT a render signal — and even when boolean it only means the preview booted, not that the
    // current story rendered. Use waitForStoryReady (storyReady.ts) for story readiness.
    ready: boolean | Promise<void> | (() => Promise<void>)
    extract: () => Promise<Record<string, Story>>
    storyStore?: {
      cacheAllCSFFiles: () => Promise<void>
    }
    // Storybook 8 render-lifecycle state; `phase` progresses through "preparing"/"rendering"/...
    // to "completed" (or "errored").
    currentRender?: { id?: string; phase?: string }
  }
}
