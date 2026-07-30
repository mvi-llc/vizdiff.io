import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { DatabasePool } from "./database"
import { beginBuildProgress, endBuildProgress, getCurrentBuildProgress } from "./progress"

const mockQuery = vi.fn()
const mockRelease = vi.fn()

vi.mock("./database", () => ({
  DatabasePool: vi.fn(async () => ({ query: mockQuery, release: mockRelease })),
}))

/** Flush the fire-and-forget persist chain (DatabasePool acquire + query + release). */
async function flushPersist(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe("build progress tracking (#452)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 })
    mockRelease.mockReset()
    vi.mocked(DatabasePool).mockClear()
  })
  afterEach(() => {
    endBuildProgress()
    vi.useRealTimers()
  })

  it("tracks the begin/get/end lifecycle", () => {
    expect(getCurrentBuildProgress()).toBeUndefined()

    const progress = beginBuildProgress(42, 7)
    expect(progress.buildId).toBe(42)
    expect(progress.expectedStories).toBe(7)
    expect(progress.completedStories).toBe(0)
    expect(progress.startedAtMs).toBe(Date.now())
    expect(progress.lastProgressAtMs).toBe(progress.startedAtMs)
    expect(getCurrentBuildProgress()).toBe(progress)

    endBuildProgress()
    expect(getCurrentBuildProgress()).toBeUndefined()
  })

  it("completeStory() counts completions and refreshes lastProgressAtMs; touch() does not count", async () => {
    const progress = beginBuildProgress(42, 3)
    const startMs = progress.lastProgressAtMs

    await vi.advanceTimersByTimeAsync(5_000)
    progress.completeStory()
    expect(progress.completedStories).toBe(1)
    expect(progress.lastProgressAtMs).toBe(startMs + 5_000)

    await vi.advanceTimersByTimeAsync(5_000)
    progress.touch()
    expect(progress.completedStories).toBe(1)
    expect(progress.lastProgressAtMs).toBe(startMs + 10_000)
  })

  it("persists last_progress_at (without touching updated_at) at most once per 2 s window", async () => {
    const progress = beginBuildProgress(42, 100)

    // A burst of completions within one throttle window coalesces to a single UPDATE.
    for (let i = 0; i < 10; i++) {
      progress.completeStory()
    }
    await flushPersist()
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/UPDATE screenshot_tests SET last_progress_at = NOW\(\)/)
    expect(sql).not.toContain("updated_at")
    expect(params).toEqual([42])
    expect(mockRelease).toHaveBeenCalledTimes(1)

    // Still inside the window: no additional write.
    await vi.advanceTimersByTimeAsync(1_999)
    progress.completeStory()
    await flushPersist()
    expect(mockQuery).toHaveBeenCalledTimes(1)

    // Past the window: the next touch persists again.
    await vi.advanceTimersByTimeAsync(1)
    progress.completeStory()
    await flushPersist()
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it("touch()/completeStory() on a stale handle after endBuildProgress() are no-ops", async () => {
    const progress = beginBuildProgress(42, 5)
    progress.completeStory()
    await flushPersist()
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const lastMs = progress.lastProgressAtMs

    endBuildProgress()
    await vi.advanceTimersByTimeAsync(60_000)
    progress.touch()
    progress.completeStory()
    await flushPersist()

    // No state mutation and no heartbeat for a finished build.
    expect(progress.completedStories).toBe(1)
    expect(progress.lastProgressAtMs).toBe(lastMs)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it("a stale handle from a previous build cannot heartbeat the next build", async () => {
    const first = beginBuildProgress(1, 5)
    await flushPersist()
    const second = beginBuildProgress(2, 5)

    first.completeStory()
    await flushPersist()
    expect(second.completedStories).toBe(0)
    // Any persisted heartbeat must target the current build only.
    for (const call of mockQuery.mock.calls as [string, unknown[]][]) {
      expect(call[1]).toEqual([2])
    }
  })

  it("swallows database errors (the heartbeat never throws into the render path)", async () => {
    mockQuery.mockRejectedValue(new Error("db down"))
    const progress = beginBuildProgress(42, 5)

    expect(() => progress.completeStory()).not.toThrow()
    await flushPersist()
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledTimes(1)
  })
})
