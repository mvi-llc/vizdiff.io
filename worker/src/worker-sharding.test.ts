/**
 * Sharded ingest path (issue #456, Phase B): with WORKER_SHARDING_ENABLED and a story count at
 * or above WORKER_SHARD_MIN_STORIES, the discovery (ingest) task must enqueue
 * render_story_chunk tasks and return with the build left "running" — no inline rendering, no
 * completion aggregation, browser pool torn down. Below the threshold the inline path runs
 * unchanged. This lives in its own file because the environment mock (low threshold/chunk size)
 * is per module graph; worker.test.ts keeps the real environment, where its story counts stay
 * below WORKER_SHARD_MIN_STORIES so the inline path runs even with the flag's default now ON.
 */

import "reflect-metadata"
import fs, { type WriteStream } from "node:fs"
import { ScreenshotTest } from "shared"
import { Readable } from "stream"
import type { DataSourceOptions, DataSource } from "typeorm"
import { expect, describe, it, beforeEach, afterEach, vi } from "vitest"
import { remote } from "webdriverio"

import { Database, DatabasePool } from "./database"
import { ingestStorybook } from "./ingest"
import { captureStoryWithRetry, getStorybookStories } from "./stories"

const mockSend = vi.fn()
const mockScreenshotTestSave = vi.fn()
const mockTestResultSave = vi.fn()
const mockPoolQuery = vi.fn()

// Three stories: at/above the mocked WORKER_SHARD_MIN_STORIES (2), so the sharded branch takes
// over; with WORKER_SHARD_CHUNK_SIZE 2 they split into chunks of [2, 1].
const mockStories = {
  "story-a": { id: "story-a", name: "A", importPath: "./stories/A.stories.tsx" },
  "story-b": { id: "story-b", name: "B", importPath: "./stories/B.stories.tsx" },
  "story-c": { id: "story-c", name: "C", importPath: "./stories/C.stories.tsx" },
}

vi.mock("@aws-sdk/client-s3", () => {
  const MockS3Client = vi.fn(function (this: { send: typeof mockSend }) {
    this.send = mockSend
  })
  class MockGetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }
  return { S3Client: MockS3Client, GetObjectCommand: MockGetObjectCommand }
})

// Sharding flag ON with a low threshold and a chunk size of 2 (per-module-graph environment).
vi.mock("./environment", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    WORKER_SHARDING_ENABLED: true,
    WORKER_SHARD_MIN_STORIES: 2,
    WORKER_SHARD_CHUNK_SIZE: 2,
  }
})

vi.mock("./database", () => ({
  Database: vi.fn(),
  DatabasePool: vi.fn(),
  closeDatabasePool: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("./stories", () => ({
  navigateToStorybook: vi.fn().mockResolvedValue(undefined),
  getStorybookStories: vi.fn().mockImplementation(async () => mockStories),
  captureStoryWithRetry: vi
    .fn()
    .mockImplementation(async ({ story }: { story: { id: string; name: string } }) => ({
      kind: "captured" as const,
      captured: {
        story,
        screenshotPath: `/tmp/test/${story.id}.png`,
        screenshotBuffer: Buffer.from("mock screenshot"),
        viewport: { width: 1200, height: 900, devicePixelRatio: 1 },
        captureDurationMs: 5,
      },
    })),
  finalizeStoryWithRecording: vi
    .fn()
    .mockImplementation(
      async ({
        story,
        testResultTable,
      }: {
        story: { id: string; name: string }
        testResultTable: { save: (r: unknown) => Promise<unknown> }
      }) => {
        const result = { id: 1, name: story.name, storyId: story.id, changeStatus: "new" as const }
        await testResultTable.save(result)
        return result
      },
    ),
}))

vi.mock("./extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extract")>()
  return { ...actual, safeExtract: vi.fn().mockResolvedValue(undefined) }
})

type MockBrowser = {
  capabilities: { browserName: string; browserVersion: string; platformName: string }
  [method: string]: unknown
}

async function mockRemoteBrowser(): Promise<MockBrowser> {
  return {
    url: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    saveScreenshot: vi.fn().mockResolvedValue(Buffer.from("mock screenshot")),
    execute: vi.fn().mockResolvedValue(true),
    waitUntil: vi.fn().mockResolvedValue(true),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    capabilities: { browserName: "chrome", browserVersion: "latest", platformName: "linux" },
  }
}

vi.mock("webdriverio", () => ({
  remote: vi.fn().mockImplementation(async () => await mockRemoteBrowser()),
}))

vi.mock("node:http", () => {
  const mockServer = {
    listen: vi.fn().mockImplementation((_port: unknown, callback?: () => void) => {
      callback?.()
      return mockServer
    }),
    address: vi.fn().mockReturnValue({ port: 12345 }),
    close: vi.fn().mockImplementation((callback?: () => void) => {
      callback?.()
    }),
    once: vi.fn().mockImplementation((event: string, callback: () => void) => {
      if (event === "listening") {
        callback()
      }
      return mockServer
    }),
  }
  return {
    default: { createServer: vi.fn().mockReturnValue(mockServer) },
    createServer: vi.fn().mockReturnValue(mockServer),
  }
})

describe("sharded ingest handoff (#456 Phase B)", () => {
  // No commitSha/branch (skips the previous-results cleanup transaction) and no baseCommitSha
  // (skips the baseline prefetch) keeps the harness minimal.
  const mockScreenshotTest = {
    id: 123,
    buildNumber: 7,
    status: "pending",
    baseCommitSha: undefined,
    createdAt: new Date(),
    uploadId: "test-upload",
    project: { id: "test-project" },
  }

  beforeEach(() => {
    mockSend.mockReset()
    mockScreenshotTestSave.mockReset()
    mockTestResultSave.mockReset()
    mockPoolQuery.mockReset()

    mockSend.mockImplementation(async () => ({
      Body: Readable.from([Buffer.from("mock tarball content")]),
    }))

    vi.mocked(Database).mockImplementation(
      async () =>
        ({
          getRepository: vi.fn().mockImplementation((entity) => {
            if (entity === ScreenshotTest) {
              return {
                findOneBy: vi.fn().mockResolvedValue(mockScreenshotTest),
                save: mockScreenshotTestSave.mockImplementation(async (test: unknown) => test),
              }
            }
            return {
              createQueryBuilder: vi.fn().mockReturnValue({
                leftJoinAndSelect: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                andWhere: vi.fn().mockReturnThis(),
                getMany: vi.fn().mockResolvedValue([]),
              }),
              save: mockTestResultSave.mockImplementation(async (result: unknown) => result),
            }
          }),
          "@instanceof": Symbol.for("TypeORM.DataSource"),
          name: "default",
          options: { type: "postgres", database: "test" } as DataSourceOptions,
          isInitialized: true,
        }) as unknown as DataSource,
    )

    vi.mocked(DatabasePool).mockImplementation(
      async () =>
        ({
          query: mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 }),
          release: vi.fn(),
        }) as unknown as Awaited<ReturnType<typeof DatabasePool>>,
    )

    // File system: the tarball download writes through a stream; extraction is stubbed.
    const writeStream = {
      on: vi.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === "finish") {
          cb()
        }
        return writeStream
      }),
      once: vi.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === "finish") {
          cb()
        }
        return writeStream
      }),
      removeListener: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      prependListener: vi.fn().mockReturnThis(),
      prependOnceListener: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      pipe: vi.fn().mockReturnThis(),
      emit: vi.fn().mockReturnValue(true),
      close: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      bytesWritten: 0,
      path: "",
      pending: false,
      writable: true,
    } as unknown as WriteStream
    vi.spyOn(fs, "createWriteStream").mockReturnValue(writeStream)
    vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined)
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined)

    // Reset the entity's mutable state between tests.
    mockScreenshotTest.status = "pending"
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it("enqueues render_story_chunk tasks, records the expected story count, and leaves the build running", async () => {
    await ingestStorybook("test-project", 123, "test-upload")

    // expected_story_count persisted before the chunks were enqueued.
    expect(mockScreenshotTestSave).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStoryCount: 3 }),
    )

    // One multi-row INSERT with a render_story_chunk task per chunk: 3 stories at chunk size 2
    // -> chunks [story-a, story-b] and [story-c].
    const insertCalls = mockPoolQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes("INSERT INTO task_queue"),
    )
    expect(insertCalls).toHaveLength(1)
    const [sql, params] = insertCalls[0]! as [string, unknown[]]
    expect(sql).toContain("'render_story_chunk'")
    expect(params).toHaveLength(4) // 2 chunks x (screenshot_test_id, data)
    expect(params[0]).toBe(123)
    expect(params[2]).toBe(123)
    const chunk0 = JSON.parse(params[1] as string) as Record<string, unknown>
    const chunk1 = JSON.parse(params[3] as string) as Record<string, unknown>
    expect(chunk0).toMatchObject({
      projectId: "test-project",
      uploadId: "test-upload",
      storyIds: ["story-a", "story-b"],
      chunkIndex: 0,
      chunkCount: 2,
    })
    expect(chunk1).toMatchObject({ storyIds: ["story-c"], chunkIndex: 1, chunkCount: 2 })

    // No inline rendering happened, and the build was never flipped out of "running": the
    // chunk workers own completion now.
    expect(captureStoryWithRetry).not.toHaveBeenCalled()
    expect(mockTestResultSave).not.toHaveBeenCalled()
    expect(mockScreenshotTestSave).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    )
    expect(mockScreenshotTestSave).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "no_changes" }),
    )
    expect(mockScreenshotTestSave).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "unapproved" }),
    )
    expect(mockScreenshotTest.status).toBe("running")

    // Single-worker ownership was released for the chunk workers.
    const lastSave = mockScreenshotTestSave.mock.calls.at(-1)![0] as { workerId: string | null }
    expect(lastSave.workerId).toBeNull()

    // The discovery pool was torn down at handoff.
    const launched = await Promise.all(
      vi
        .mocked(remote)
        .mock.results.filter((r) => r.type === "return")
        .map((r) => r.value as Promise<MockBrowser>),
    )
    expect(launched.length).toBeGreaterThan(0)
    for (const browser of launched) {
      expect(browser.deleteSession).toHaveBeenCalled()
    }
  })

  it("renders inline (no chunk tasks) when the story count is below WORKER_SHARD_MIN_STORIES", async () => {
    // One story < WORKER_SHARD_MIN_STORIES (2): the flag is on but the build is too small.
    vi.mocked(getStorybookStories).mockResolvedValueOnce({
      "story-a": mockStories["story-a"],
    } as never)

    await ingestStorybook("test-project", 123, "test-upload")

    const insertCalls = mockPoolQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes("INSERT INTO task_queue"),
    )
    expect(insertCalls).toHaveLength(0)

    // Inline path: rendered here, expected count still recorded, build completed.
    expect(captureStoryWithRetry).toHaveBeenCalledTimes(1)
    expect(mockScreenshotTestSave).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStoryCount: 1 }),
    )
    expect(mockScreenshotTestSave).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.stringMatching(/^(no_changes|unapproved)$/),
        buildDurationSec: expect.any(Number),
      }),
    )
  })
})
