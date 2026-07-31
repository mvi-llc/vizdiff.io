/**
 * This test suite verifies the worker service that processes Storybook builds.
 * The worker:
 * 1. Downloads a tarball from S3
 * 2. Extracts it locally
 * 3. Starts an HTTP server to serve the files
 * 4. Uses WebdriverIO to take screenshots
 * 5. Compares screenshots with baseline images
 * 6. Saves results to the database
 *
 * Because this involves many external services, we mock:
 * - S3 for tarball storage
 * - File system operations
 * - Database operations (TypeORM)
 * - WebdriverIO for browser control
 * - HTTP server for serving files
 * - PostgreSQL notification system
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// These eslint-disable directives are used because we're mocking complex database types for testing

import "reflect-metadata"
import { S3Client, GetObjectCommand, type S3ClientResolvedConfig } from "@aws-sdk/client-s3"
import type { MiddlewareStack } from "@aws-sdk/types"
import fs, { type PathLike, type WriteStream } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { TestResult, ScreenshotTest } from "shared"
import { Readable } from "stream"
import type { DataSourceOptions, Repository, DataSource } from "typeorm"
import { expect, describe, it, afterAll, beforeEach, vi, afterEach } from "vitest"
import { remote } from "webdriverio"

import { Database, DatabasePool } from "./database"
import { safeExtract } from "./extract"
import { WORKER_ID } from "./identity"
import {
  computeBuildTimeoutMs,
  failBuildBeforeExit,
  ingestStorybook,
  isBaselineBuildPending,
} from "./ingest"
import { log } from "./log"
import { captureStoryWithRetry } from "./stories"
import { DependencyNotReadyError, NonRetryableTaskError, isPermanentS3FetchError } from "./tasks"
import { BuildTimeoutError } from "./timeout"
import { postBuildFailedStatus } from "./vcsStatus"
import {
  handleShutdownSignal,
  processTask,
  reclaimOrphanedBuilds,
  shutdown,
  startStuckBuildSweepTimer,
  startTask,
  sweepStuckBuilds,
} from "./worker"

// Mock function declarations - these track calls to key operations
const mockSend = vi.fn()
const mockScreenshotTestSave = vi.fn()
const mockTestResultSave = vi.fn()

// Test fixtures - reusable mock data
const mockStories = {
  story1: {
    id: "story1",
    name: "Story 1",
    importPath: "./stories/Story1.stories.tsx",
  },
}

// Mock S3 client and commands.
// vitest 4 constructs these mocks with `new` and no longer treats arrow
// functions as constructable. `S3Client` is a `vi.fn()` (so tests can assert
// `toHaveBeenCalled` / override it via `mockImplementation`) backed by a
// constructable `function` implementation. `GetObjectCommand` is a real class
// because tests rely on `instanceof` / `expect.any(GetObjectCommand)`.
vi.mock("@aws-sdk/client-s3", () => {
  const MockS3Client = vi.fn(function (this: { send: typeof mockSend }) {
    this.send = mockSend
  })

  class MockGetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }

  return { S3Client: MockS3Client, GetObjectCommand: MockGetObjectCommand }
})

// Prevent the worker from starting its polling loop
vi.mock("./worker", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    main: vi.fn(),
    pollForNewTasks: vi.fn(),
  }
})

// Stub the best-effort VCS status helper (issue #451) so tests can assert exactly when a failed
// status is posted, without touching the GitHub/GitLab clients. parseBuildCheckData stays real.
vi.mock("./vcsStatus", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    postBuildFailedStatus: vi.fn().mockResolvedValue(undefined),
  }
})

// Mock tasks module. Keep the real error/control-flow exports
// (NonRetryableTaskError / isPermanentS3FetchError / DependencyNotReadyError) so
// ingest.ts and worker.ts behave as in production; only stub the DB-touching
// queue functions.
vi.mock("./tasks", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    claimNextTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    // The task-lock heartbeat's own behavior (interval, ownership guard) is covered in
    // tasks.test.ts; here it is stubbed so startTask tests can assert the start/stop wiring.
    startTaskLockHeartbeat: vi.fn().mockReturnValue(vi.fn()),
  }
})

// Partial mock of the sharding module (issue #456, Phase B): stub only the chunk entry points
// so processTask dispatch can be asserted; everything else (the shared render internals the
// ingest tests exercise, computeBuildTimeoutMs, etc.) stays real.
vi.mock("./shard", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    runRenderChunk: vi.fn().mockResolvedValue(undefined),
    giveUpOnChunkTask: vi.fn().mockResolvedValue(undefined),
  }
})

// Mock database connection
vi.mock("./database", () => ({
  Database: vi.fn().mockImplementation(async () => ({
    getRepository: vi.fn().mockImplementation(() => ({
      createQueryBuilder: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnThis(),
        leftJoinAndSelect: vi.fn().mockReturnThis(),
      }),
      save: vi.fn().mockResolvedValue({}),
      findOneBy: vi.fn().mockResolvedValue(null),
    })),
    "@instanceof": Symbol.for("TypeORM.DataSource"),
    name: "default",
    options: { type: "postgres", database: "test" } as DataSourceOptions,
    isInitialized: true,
  })),
  DatabasePool: vi.fn(async () => ({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  })),
  closeDatabasePool: vi.fn().mockResolvedValue(undefined),
}))

// Mock browser shape: a bag of vi.fn() stubs plus capabilities. The index signature lets tests
// override individual methods (e.g. deleteSession) without re-declaring the whole surface.
type MockBrowser = {
  capabilities: { browserName: string; browserVersion: string; platformName: string }
  [method: string]: unknown
}

// Default mock browser factory, shared so individual tests can build on it (e.g. overriding
// deleteSession) without re-declaring the whole browser surface.
async function actualRemoteMock(): Promise<MockBrowser> {
  log.debug("WebdriverIO remote called")
  let storyStoreReady = false
  return {
    url: vi.fn().mockImplementation(async (url: string) => {
      log.debug(`WebdriverIO url called with: ${url}`)
    }),
    setViewport: vi
      .fn()
      .mockImplementation(
        async (viewport: { width: number; height: number; devicePixelRatio: number }) => {
          log.debug(`WebdriverIO setViewport called with: ${JSON.stringify(viewport)}`)
        },
      ),
    saveScreenshot: vi.fn().mockImplementation(async () => {
      log.debug("WebdriverIO saveScreenshot called")
      return Buffer.from("mock screenshot")
    }),
    execute: vi.fn().mockImplementation(async (fn?: () => unknown) => {
      log.debug(`WebdriverIO execute called, hasFunction: ${String(!!fn)}`)
      // If a function is passed, this is the storyStore check
      if (fn) {
        if (!storyStoreReady) {
          storyStoreReady = true
          return true
        }
        return mockStories
      }
      // Otherwise this is the story extraction
      return mockStories
    }),
    waitUntil: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => {
      log.debug("WebdriverIO waitUntil called")
      await fn()
      return true
    }),
    deleteSession: vi.fn().mockImplementation(async () => {
      log.debug("WebdriverIO deleteSession called")
    }),
    capabilities: {
      browserName: "chrome",
      browserVersion: "latest",
      platformName: "linux",
    },
  }
}

// Mock WebdriverIO browser automation
vi.mock("webdriverio", () => ({
  remote: vi.fn().mockImplementation(actualRemoteMock),
}))

// Stub extraction. `safeExtract` now opens its own read stream (`createReadStream(tarballPath)`) so
// it can drive tar's streaming form and abort on a violation; mocking `tar` alone would leave that
// real fs read hitting a nonexistent test tarball. The orchestration tests here don't exercise
// extraction (the only failure-path test fails earlier, at S3 download), so stub it to a no-op.
// `safeExtract`'s own behavior is covered directly in extract.test.ts.
vi.mock("./extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extract")>()
  return {
    ...actual,
    safeExtract: vi.fn().mockImplementation(async () => {
      log.debug("safeExtract called")
    }),
  }
})

// Mock environment so the build timeout (and the post-abort grace period and fatal failsafe
// bound) are short enough to exercise in tests without slowing the suite. All other exports keep
// their real values.
vi.mock("./environment", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    BUILD_TIMEOUT_MS: 50,
    BUILD_ABORT_GRACE_MS: 500,
    WORKER_FATAL_FAILSAFE_TIMEOUT_MS: 300,
  }
})

// Mock story processing module. The ingest fan-out now runs the capture/finalize split (issue
// #456): captureStoryWithRetry holds the browser session and hands a CapturedStory to
// finalizeStoryWithRecording, which does the S3/diff/DB work and persists the TestResult.
vi.mock("./stories", () => ({
  navigateToStorybook: vi.fn().mockImplementation(async () => {
    log.debug("navigateToStorybook called")
  }),
  getStorybookStories: vi.fn().mockImplementation(async () => {
    log.debug("getStorybookStories called")
    return mockStories
  }),
  captureStoryWithRetry: vi
    .fn()
    .mockImplementation(async ({ story }: { story: { id: string; name: string } }) => {
      log.debug(`captureStoryWithRetry called with story: ${JSON.stringify(story)}`)
      return {
        kind: "captured" as const,
        captured: {
          story,
          screenshotPath: `/tmp/test/${story.id}.png`,
          screenshotBuffer: Buffer.from("mock screenshot"),
          viewport: { width: 1200, height: 900, devicePixelRatio: 1 },
          captureDurationMs: 5,
        },
      }
    }),
  finalizeStoryWithRecording: vi.fn().mockImplementation(
    async (
      {
        story,
        testResultTable,
        uploadId,
      }: {
        story: { id: string; name: string }
        testResultTable: Repository<TestResult>
        uploadId: string
      },
      _captured: unknown,
    ) => {
      log.debug(`finalizeStoryWithRecording called with story: ${JSON.stringify(story)}`)
      const result = {
        id: 1,
        name: story.name,
        storyId: story.id,
        screenshotTestId: 123,
        changeStatus: "new" as const,
        baselineImageUrl: "mock-baseline-url",
        newImageUrl: `mock-new-url-${uploadId}`,
        diffImageUrl: "mock-diff-url",
        diffRatio: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      log.debug(`finalizeStoryWithRecording returning: ${JSON.stringify(result)}`)
      await testResultTable.save(result)
      return result
    },
  ),
}))

// Mock HTTP server for serving Storybook files
vi.mock("node:http", () => {
  const mockServer = {
    listen: vi.fn().mockImplementation((_port, callback?: () => void) => {
      log.debug("HTTP server started")
      if (callback) {
        callback()
      }
      return mockServer
    }),
    address: vi.fn().mockReturnValue({ port: 12345 }),
    close: vi.fn().mockImplementation((callback?: () => void) => {
      log.debug("HTTP server closed")
      if (callback) {
        callback()
      }
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

// Mock PostgreSQL notification system
vi.mock("pg-listen", () => ({
  default: vi.fn().mockImplementation(() => ({
    notifications: { on: vi.fn() },
    events: { on: vi.fn() },
    connect: vi.fn(),
    listenTo: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Mock PostgreSQL connection pool
vi.mock("pg", () => {
  const mockPool = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    }),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    end: vi.fn().mockResolvedValue(undefined),
  }))

  return {
    __esModule: true,
    Pool: mockPool,
    default: { Pool: mockPool },
  }
})

describe("worker", () => {
  // Test fixtures - reusable mock data
  const mockScreenshotTest = {
    id: 123,
    status: "pending",
    baseCommitSha: "abc123",
    createdAt: new Date(),
    uploadId: "test-upload",
    project: { id: "test-project" },
  }
  const mockBaseTestResult = {
    id: 456,
    storyId: "story1",
    screenshotTest: {
      id: 123,
      uploadId: "base-upload",
    },
    changeStatus: "unchanged",
  }

  beforeEach(() => {
    // Reset all mocks before each test
    mockSend.mockReset()
    mockScreenshotTestSave.mockReset()
    mockTestResultSave.mockReset()

    // Setup S3 mock to return appropriate content based on the key
    mockSend.mockImplementation(async (command: { input: { Key?: string } }) => {
      const key = command.input.Key
      if (!key) {
        throw new Error("Missing key in S3 command")
      }

      if (key.includes(".tar.gz")) {
        return { Body: Readable.from([Buffer.from("mock tarball content")]) }
      }
      if (key.includes("screenshots")) {
        return { Body: Readable.from([Buffer.from("mock baseline image")]) }
      }
      throw new Error(`Unexpected S3 key: ${key}`)
    })

    // Setup database mock with repositories
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
                innerJoin: vi.fn().mockReturnThis(),
                leftJoinAndSelect: vi.fn().mockReturnThis(),
                where: vi.fn().mockReturnThis(),
                andWhere: vi.fn().mockReturnThis(),
                getMany: vi.fn().mockResolvedValue([mockBaseTestResult]),
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

    // Setup file system mocks
    const writeStream = createMockWriteStream()
    vi.spyOn(fs, "createWriteStream").mockReturnValue(writeStream)
    vi.spyOn(fs.promises, "readFile").mockImplementation(async (path: PathLike | FileHandle) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      if (path.toString().endsWith("iframe.html")) {
        return `window['STORIES'] = ${JSON.stringify(mockStories)};`
      }
      return Buffer.from("mock file content")
    })
    vi.spyOn(fs.promises, "rm").mockResolvedValue(undefined)
    vi.spyOn(fs.promises, "mkdir").mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    shutdown()
  })

  // Helper function to create a mock write stream
  function createMockWriteStream(): WriteStream {
    const callbacks = new Map<string, Array<() => void>>()
    const writeStream = {
      on: vi.fn().mockImplementation((event: string, callback: () => void) => {
        const handlers = callbacks.get(event) ?? []
        handlers.push(callback)
        callbacks.set(event, handlers)
        if (event === "finish") {
          callback()
        }
        return writeStream
      }),
      once: vi.fn().mockImplementation((event: string, callback: () => void) => {
        if (event === "finish") {
          callback()
        }
        return writeStream
      }),
      removeListener: vi.fn().mockReturnThis(),
      addListener: vi.fn().mockReturnThis(),
      prependListener: vi.fn().mockReturnThis(),
      prependOnceListener: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      pipe: vi.fn().mockReturnThis(),
      close: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      emit: vi.fn().mockImplementation((event: string) => {
        const handlers = callbacks.get(event) ?? []
        handlers.forEach((handler) => handler())
        return true
      }),
      bytesWritten: 0,
      path: "",
      pending: false,
      writable: true,
      destroy: vi.fn(),
    } as unknown as WriteStream
    return writeStream
  }

  describe("processTask", () => {
    it("should fail to process an unknown task", async () => {
      let error: Error | undefined
      try {
        await processTask("unknown_task_type", 0, {})
      } catch (err) {
        error = err as Error
      }
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toBe("Unknown task type: unknown_task_type")
    })

    // Cross-worker sharding (issue #456, Phase B): render_story_chunk tasks dispatch to
    // runRenderChunk WITHOUT the isBaselineBuildPending gate (chunks only exist because the
    // discovery task already passed it — and the Database mock here would throw on the gate's
    // query-builder anyway, so a regression would fail loudly).
    it("dispatches render_story_chunk tasks to runRenderChunk", async () => {
      const { runRenderChunk } = await import("./shard")
      const payload = {
        projectId: "test-project",
        uploadId: "test-upload",
        storyIds: ["story-a", "story-b"],
        chunkIndex: 0,
        chunkCount: 2,
      }

      await processTask("render_story_chunk", 123, payload)

      expect(runRenderChunk).toHaveBeenCalledTimes(1)
      expect(runRenderChunk).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "test-project",
          uploadId: "test-upload",
          storyIds: ["story-a", "story-b"],
          chunkIndex: 0,
          chunkCount: 2,
        }),
        123,
        // processTask is invoked directly (no claimed task), so no queue row id is threaded.
        undefined,
      )
    })

    it("rejects an invalid render_story_chunk payload as non-retryable", async () => {
      const originalError = log.error
      log.error = vi.fn()
      const { runRenderChunk } = await import("./shard")

      await expect(
        processTask("render_story_chunk", 123, { projectId: "test-project" }),
      ).rejects.toBeInstanceOf(NonRetryableTaskError)

      expect(runRenderChunk).not.toHaveBeenCalled()
      log.error = originalError
    })

    // Regression (#456 follow-up): the api enqueues the ingest payload with the NUMERIC
    // Project.id, and pre-fix chunk payloads copied it verbatim — parseRenderChunkPayload
    // rejected the number, so every chunk task was deleted as non-retryable and the build sat
    // in "running" until the sweeper failed it. A numeric projectId must dispatch normally,
    // normalized to a string.
    it("accepts a numeric projectId in a render_story_chunk payload, normalized to a string", async () => {
      const { runRenderChunk } = await import("./shard")

      await processTask("render_story_chunk", 123, {
        projectId: 42,
        uploadId: "test-upload",
        storyIds: ["story-a"],
        chunkIndex: 0,
        chunkCount: 1,
      })

      expect(runRenderChunk).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "42", uploadId: "test-upload" }),
        123,
        undefined,
      )
    })

    it("rejects an ingest_storybook payload with null/missing ids", async () => {
      const originalError = log.error
      log.error = vi.fn()

      await expect(
        processTask("ingest_storybook", 123, { projectId: null, uploadId: "test-upload" }),
      ).rejects.toThrow(/Missing required ingest_storybook fields/)

      log.error = originalError
    })
  })

  describe("task-lock heartbeat wiring (#456 follow-up)", () => {
    const chunkTask = {
      id: 55,
      task_type: "render_story_chunk",
      screenshot_test_id: 123,
      data: {
        projectId: "test-project",
        uploadId: "test-upload",
        storyIds: ["story-a"],
        chunkIndex: 0,
        chunkCount: 1,
      },
      attempts: 1,
    }

    it("starts the heartbeat when a claimed task starts and stops it when the task finishes", async () => {
      const { startTaskLockHeartbeat } = await import("./tasks")
      const stop = vi.fn()
      vi.mocked(startTaskLockHeartbeat).mockReturnValue(stop)

      await startTask(chunkTask)

      expect(startTaskLockHeartbeat).toHaveBeenCalledWith(55)
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it("stops the heartbeat when the task fails", async () => {
      const originalError = log.error
      log.error = vi.fn()
      const { startTaskLockHeartbeat } = await import("./tasks")
      const { runRenderChunk } = await import("./shard")
      const stop = vi.fn()
      vi.mocked(startTaskLockHeartbeat).mockReturnValue(stop)
      vi.mocked(runRenderChunk).mockRejectedValueOnce(new Error("chunk render failed"))

      await expect(startTask(chunkTask)).rejects.toThrow("chunk render failed")

      expect(startTaskLockHeartbeat).toHaveBeenCalledWith(55)
      expect(stop).toHaveBeenCalledTimes(1)
      log.error = originalError
    })
  })

  describe("isPermanentS3FetchError", () => {
    it("classifies NoSuchKey as permanent", () => {
      expect(isPermanentS3FetchError({ name: "NoSuchKey" })).toBe(true)
    })

    it("classifies a 404 status code as permanent", () => {
      expect(isPermanentS3FetchError({ $metadata: { httpStatusCode: 404 } })).toBe(true)
    })

    it("classifies a NotFound name as permanent", () => {
      expect(isPermanentS3FetchError({ name: "NotFound" })).toBe(true)
    })

    it("classifies InvalidObjectState (Glacier archive) as permanent", () => {
      expect(isPermanentS3FetchError({ name: "InvalidObjectState" })).toBe(true)
    })

    it("keeps a 403/AccessDenied auth error retryable", () => {
      // A transient IRSA/bucket-policy/KMS rollout or auth blip must not delete
      // the queue row for an object that actually exists.
      expect(isPermanentS3FetchError({ name: "AccessDenied" })).toBe(false)
      expect(isPermanentS3FetchError({ name: "Forbidden" })).toBe(false)
      expect(isPermanentS3FetchError({ $metadata: { httpStatusCode: 403 } })).toBe(false)
    })

    it("keeps a missing/misconfigured bucket retryable", () => {
      // A missing bucket is a recoverable deployment error; it should keep
      // retrying so it recovers once the bucket exists again.
      expect(isPermanentS3FetchError({ name: "NoSuchBucket" })).toBe(false)
    })

    it("does not classify a transient/network error as permanent", () => {
      expect(isPermanentS3FetchError(new Error("socket hang up"))).toBe(false)
      expect(isPermanentS3FetchError({ name: "TimeoutError" })).toBe(false)
      expect(isPermanentS3FetchError({ $metadata: { httpStatusCode: 500 } })).toBe(false)
      expect(isPermanentS3FetchError(undefined)).toBe(false)
      expect(isPermanentS3FetchError(null)).toBe(false)
    })
  })

  // Issue #125: render tasks must not run before the baseline build they depend
  // on. isBaselineBuildPending() detects an in-flight baseline; processTask()
  // throws DependencyNotReadyError so the worker can defer.
  describe("dependent task ordering (#125)", () => {
    // Build a Database mock whose ScreenshotTest repo returns `baseTest` from
    // findOneBy and `inFlightCount` from the dependency query's getCount().
    function mockDatabaseForDependency(
      baseTest: { id: number; baseCommitSha: string | null; project: { id: string } } | null,
      inFlightCount: number,
    ): void {
      vi.mocked(Database).mockImplementation(
        async () =>
          ({
            getRepository: vi.fn().mockImplementation((entity) => {
              if (entity === ScreenshotTest) {
                return {
                  findOneBy: vi.fn().mockResolvedValue(baseTest),
                  save: mockScreenshotTestSave.mockImplementation(async (t: unknown) => t),
                  createQueryBuilder: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnThis(),
                    andWhere: vi.fn().mockReturnThis(),
                    getCount: vi.fn().mockResolvedValue(inFlightCount),
                  }),
                }
              }
              return {
                createQueryBuilder: vi.fn().mockReturnValue({
                  leftJoinAndSelect: vi.fn().mockReturnThis(),
                  where: vi.fn().mockReturnThis(),
                  getMany: vi.fn().mockResolvedValue([]),
                }),
                save: mockTestResultSave.mockImplementation(async (r: unknown) => r),
              }
            }),
            "@instanceof": Symbol.for("TypeORM.DataSource"),
            name: "default",
            options: { type: "postgres", database: "test" } as DataSourceOptions,
            isInitialized: true,
          }) as unknown as DataSource,
      )
    }

    it("isBaselineBuildPending returns true when a baseline build is in flight", async () => {
      mockDatabaseForDependency(
        { id: 200, baseCommitSha: "base-sha", project: { id: "test-project" } },
        1,
      )
      await expect(isBaselineBuildPending(200)).resolves.toBe(true)
    })

    it("isBaselineBuildPending returns false when no baseline build is in flight", async () => {
      mockDatabaseForDependency(
        { id: 200, baseCommitSha: "base-sha", project: { id: "test-project" } },
        0,
      )
      await expect(isBaselineBuildPending(200)).resolves.toBe(false)
    })

    it("isBaselineBuildPending returns false when the test has no base commit", async () => {
      mockDatabaseForDependency(
        { id: 200, baseCommitSha: null, project: { id: "test-project" } },
        5,
      )
      await expect(isBaselineBuildPending(200)).resolves.toBe(false)
    })

    it("processTask throws DependencyNotReadyError (and does not delete the task) when the baseline is pending", async () => {
      const originalError = log.error
      log.error = vi.fn()
      mockDatabaseForDependency(
        { id: 200, baseCommitSha: "base-sha", project: { id: "test-project" } },
        1,
      )

      const { deleteTask } = await import("./tasks")

      await expect(
        processTask("ingest_storybook", 200, {
          projectId: "test-project",
          uploadId: "test-upload",
        }),
      ).rejects.toBeInstanceOf(DependencyNotReadyError)

      // The task must remain in the queue so it can be retried after the
      // dependency finishes.
      expect(deleteTask).not.toHaveBeenCalled()

      log.error = originalError
    })

    // Regression (#456 follow-up): the api's ingest payload carries the NUMERIC Project.id.
    // The boundary normalization must accept it (reaching the baseline-dependency gate, i.e.
    // normal ingest control flow) instead of failing the missing-fields guard.
    it("processTask accepts the api's numeric projectId for ingest_storybook", async () => {
      const originalError = log.error
      log.error = vi.fn()
      mockDatabaseForDependency(
        { id: 200, baseCommitSha: "base-sha", project: { id: "test-project" } },
        1,
      )

      await expect(
        processTask("ingest_storybook", 200, { projectId: 42, uploadId: "test-upload" }),
      ).rejects.toBeInstanceOf(DependencyNotReadyError)

      log.error = originalError
    })
  })

  describe("ingestStorybook", () => {
    it("should process a storybook build and generate test results", async () => {
      const projectId = "test-project"
      const uploadId = "test-upload"
      const screenshotTestId = 123

      await ingestStorybook(projectId, screenshotTestId, uploadId)

      // Verify S3 interactions
      expect(S3Client).toHaveBeenCalled()
      expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand))

      // Prewarm (issue #456): the browser pool starts launching (remote()) BEFORE the tarball is
      // extracted, so session startup overlaps the download/extract instead of following it.
      const firstRemoteCall = vi.mocked(remote).mock.invocationCallOrder[0]
      const firstExtractCall = vi.mocked(safeExtract).mock.invocationCallOrder[0]
      expect(firstRemoteCall).toBeDefined()
      expect(firstExtractCall).toBeDefined()
      expect(firstRemoteCall!).toBeLessThan(firstExtractCall!)

      // Verify screenshot test status updates
      expect(mockScreenshotTestSave).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.stringMatching(/^(no_changes|unapproved)$/),
          buildDurationSec: expect.any(Number),
        }),
      )

      // Verify test results were created
      expect(mockTestResultSave).toHaveBeenCalledWith(
        expect.objectContaining({
          storyId: "story1",
          screenshotTestId,
          changeStatus: expect.stringMatching(/^(new|unchanged|changed)$/),
          newImageUrl: expect.stringContaining(uploadId),
          diffRatio: expect.any(Number),
        }),
      )
    }, 10000)

    it("should handle missing base test results gracefully", async () => {
      // Setup database mock without base commit data
      const mockScreenshotTestNoBase = { ...mockScreenshotTest, baseCommitSha: undefined }
      vi.mocked(Database).mockImplementation(
        async () =>
          ({
            getRepository: vi.fn().mockImplementation((entity) => {
              if (entity === ScreenshotTest) {
                return {
                  findOneBy: vi.fn().mockResolvedValue(mockScreenshotTestNoBase),
                  save: mockScreenshotTestSave.mockImplementation(async (test: unknown) => {
                    log.debug(`ScreenshotTest save called with: ${JSON.stringify(test)}`)
                    return test
                  }),
                }
              }
              return {
                createQueryBuilder: vi.fn().mockReturnValue({
                  innerJoin: vi.fn().mockReturnThis(),
                  leftJoinAndSelect: vi.fn().mockReturnThis(),
                  where: vi.fn().mockReturnThis(),
                  getMany: vi.fn().mockResolvedValue([]),
                }),
                save: mockTestResultSave.mockImplementation(async (result: unknown) => {
                  log.debug(`TestResult save called with: ${JSON.stringify(result)}`)
                  return result
                }),
              }
            }),
            "@instanceof": Symbol.for("TypeORM.DataSource"),
            name: "default",
            options: { type: "postgres", database: "test" } as DataSourceOptions,
            isInitialized: true,
          }) as unknown as DataSource,
      )

      log.debug("Starting ingestStorybook...")
      const promise = ingestStorybook("test-project", 123, "test-upload")
      log.debug("Waiting for ingestStorybook...")
      await promise
      log.debug("ingestStorybook completed")

      // Verify all test results are marked as "new" since there's no baseline
      expect(mockTestResultSave).toHaveBeenCalledWith(
        expect.objectContaining({
          changeStatus: "new",
        }),
      )
    })

    it("should abort, wait for the render to unwind, and fail a build that exceeds the build timeout", async () => {
      // Silence the expected error/warn logging for this test.
      const originalError = log.error
      const originalWarn = log.warn
      log.error = vi.fn()
      log.warn = vi.fn()

      // Simulate a story stuck in a WebDriver op that only unsticks when the browser session is
      // force-closed by the timeout abort. captureStoryWithRetry hangs until deleteSession() is
      // called,
      // then rejects — mirroring how force-teardown makes the stuck command reject and the
      // render's `finally` (returning the session to the browser pool) run. This verifies
      // withTimeout waits for that unwind before surfacing BuildTimeoutError instead of freeing
      // the worker eagerly.
      let rejectStuckStory: ((err: Error) => void) | undefined
      let storyRejected = false
      vi.mocked(captureStoryWithRetry).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStuckStory = (err: Error) => {
              storyRejected = true
              reject(err)
            }
          }),
      )

      // When the abort closes the session, unstick the hung story (as a real WebDriver client
      // would by rejecting the in-flight command).
      vi.mocked(remote).mockImplementationOnce(async () => {
        const browser = await actualRemoteMock()
        browser.deleteSession = vi.fn().mockImplementation(async () => {
          rejectStuckStory?.(new Error("session deleted"))
        })
        return browser
      })

      const error = await ingestStorybook("test-project", 123, "test-upload").catch(
        (e: unknown) => e,
      )

      log.error = originalError
      log.warn = originalWarn

      expect(error).toBeInstanceOf(BuildTimeoutError)
      // The render must have actually unwound (story rejected) before withTimeout surfaced the
      // BuildTimeoutError — proving the worker is not freed while the render is still running.
      expect(storyRejected).toBe(true)

      // The screenshot test must be marked failed on timeout.
      expect(mockScreenshotTestSave).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      )
    }, 10000)

    it("should handle storybook extraction failures", async () => {
      // Temporarily silence the error logger
      const originalError = log.error
      log.error = vi.fn()

      // Mock S3 to simulate a download failure.
      // vitest 4 invokes mock implementations with `new`, so this must be a
      // constructable `function` rather than a (non-constructable) arrow.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- cast keeps the constructable function form vitest 4 requires
      vi.mocked(S3Client).mockImplementation(function (this: unknown) {
        return {
          send: vi.fn().mockRejectedValue(new Error("S3 error")),
          config: {
            apiVersion: "2006-03-01",
            region: "us-east-1",
            credentials: {},
            logger: {},
            requestHandler: { handle: () => Promise.resolve({}) },
          } as unknown as S3ClientResolvedConfig,
          destroy: vi.fn(),
          middlewareStack: {} as unknown as MiddlewareStack<any, any>,
        }
      } as unknown as typeof S3Client)

      await expect(ingestStorybook("test-project", 123, "test-upload")).rejects.toThrow("S3 error")

      // Restore the original logger
      log.error = originalError

      // Verify screenshot test is marked as failed
      expect(mockScreenshotTestSave).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
        }),
      )

      // Verify no test results were created since we couldn't get the stories list
      expect(mockTestResultSave).not.toHaveBeenCalled()

      // Prewarm cleanup (issue #456): the pool was started concurrently with the (failed)
      // download, so every Chrome session that launched must be torn down — an early build
      // failure must never leak headless-Chrome processes.
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

    it("should throw NonRetryableTaskError when the upload tarball is gone (NoSuchKey)", async () => {
      const originalError = log.error
      log.error = vi.fn()

      // Simulate the AWS SDK v3 NoSuchKey error shape (name + $metadata).
      const noSuchKey = Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      })
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- constructable function form vitest 4 requires
      vi.mocked(S3Client).mockImplementation(function (this: unknown) {
        return {
          send: vi.fn().mockRejectedValue(noSuchKey),
          config: {
            apiVersion: "2006-03-01",
            region: "us-east-1",
            credentials: {},
            logger: {},
            requestHandler: { handle: () => Promise.resolve({}) },
          } as unknown as S3ClientResolvedConfig,
          destroy: vi.fn(),
          middlewareStack: {} as unknown as MiddlewareStack<any, any>,
        }
      } as unknown as typeof S3Client)

      await expect(ingestStorybook("test-project", 123, "test-upload")).rejects.toThrow(
        NonRetryableTaskError,
      )

      log.error = originalError

      // The screenshot test should still be marked failed.
      expect(mockScreenshotTestSave).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      )
      expect(mockTestResultSave).not.toHaveBeenCalled()
    })
  })

  describe("computeBuildTimeoutMs (#452)", () => {
    // The environment mock leaves BUILD_TIMEOUT_FLOOR_MS (900000) and WORKER_PER_STORY_BUDGET_MS
    // (5000) at their real defaults; only the explicit-env parameter is varied per case.
    it.each([
      // [storyCount, concurrency, explicitEnvMs, expected]
      // Explicit BUILD_TIMEOUT_MS is used verbatim (back-compat), regardless of story count.
      [743, 4, 50, 50],
      [10, 1, 1_800_000, 1_800_000],
      [1000, 1, 1, 1],
      // Floor dominates small storybooks: 100 * 5000 = 500000 < 900000.
      [100, 1, undefined, 900_000],
      // Formula scales with story count: 743 * 5000 = 3715000.
      [743, 1, undefined, 3_715_000],
      // Concurrency divides the budget: ceil(3715000 / 4) = 928750 (> floor).
      [743, 4, undefined, 928_750],
      // Fractional division rounds up: ceil(1001 * 5000 / 3) = 1668334.
      [1001, 3, undefined, 1_668_334],
      // Concurrency 0 (or below) is clamped to 1 rather than dividing by zero.
      [1000, 0, undefined, 5_000_000],
    ] as const)(
      "storyCount=%s concurrency=%s explicit=%s -> %s",
      (storyCount, concurrency, explicitEnvMs, expected) => {
        expect(computeBuildTimeoutMs(storyCount, concurrency, explicitEnvMs)).toBe(expected)
      },
    )
  })

  // --- Build lifecycle hardening (issue #451) --------------------------------------------------

  // A controllable pg client mock for the raw-SQL paths (DatabasePool()). `handler` inspects the
  // SQL text and returns a result; unmatched queries return an empty result.
  type QueryResult = { rows: unknown[]; rowCount: number }
  type QueryHandler = (sql: string, params: unknown[]) => QueryResult | undefined
  function mockPoolClient(handler?: QueryHandler) {
    const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
      return handler?.(sql, params) ?? { rows: [], rowCount: 0 }
    })
    const client = { query, release: vi.fn() }
    vi.mocked(DatabasePool).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof DatabasePool>>,
    )
    return client
  }

  // Find the calls to `client.query` whose SQL matches `pattern`.
  function queriesMatching(client: { query: ReturnType<typeof vi.fn> }, pattern: RegExp) {
    return client.query.mock.calls.filter(([sql]) => pattern.test(sql as string))
  }

  // Database mock whose ScreenshotTest repository returns the given stuck builds from the two
  // query-builder passes (running, then pending) and `entity` from findOneBy (used to load the
  // build with eager relations for the VCS status post).
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
  function mockDatabaseForSweep(
    stuckRunning: any[],
    stuckPending: any[],
    entity: any = mockScreenshotTest,
  ) {
    const getMany = vi
      .fn()
      .mockResolvedValueOnce(stuckRunning)
      .mockResolvedValueOnce(stuckPending)
      .mockResolvedValue([])
    const andWhere = vi.fn()
    const findOneBy = vi.fn().mockResolvedValue(entity)
    const queryBuilder: any = { getMany }
    queryBuilder.where = vi.fn().mockReturnValue(queryBuilder)
    andWhere.mockReturnValue(queryBuilder)
    queryBuilder.andWhere = andWhere
    vi.mocked(Database).mockResolvedValue({
      getRepository: () => ({
        createQueryBuilder: () => queryBuilder,
        findOneBy,
      }),
    } as any)
    return { getMany, andWhere, findOneBy }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

  describe("sweepStuckBuilds", () => {
    const staleDate = new Date(Date.now() - 3 * 60 * 60 * 1000)

    it("fails stuck builds via a conditional UPDATE, deletes their queue rows, and posts the VCS status once each", async () => {
      const stuckRunningBuild = { id: 1, status: "running", updatedAt: staleDate }
      const stuckPendingBuild = { id: 2, status: "pending", updatedAt: staleDate }
      mockDatabaseForSweep([stuckRunningBuild], [stuckPendingBuild])

      const gitlabCheckData = { projectId: 7, commitSha: "sha", gitlabHost: "https://gitlab.com" }
      const client = mockPoolClient((sql) => {
        if (sql.includes("UPDATE screenshot_tests")) {
          return { rows: [{ id: 1 }], rowCount: 1 }
        }
        if (sql.includes("DELETE FROM task_queue")) {
          return { rows: [{ data: { gitlabCheckData } }], rowCount: 1 }
        }
        return undefined
      })

      const count = await sweepStuckBuilds()
      expect(count).toBe(2)

      // Conditional flip: the observed status is part of the WHERE clause.
      const updates = queriesMatching(client, /UPDATE screenshot_tests/)
      expect(updates).toHaveLength(2)
      expect(updates[0]![0]).toMatch(/WHERE id = \$1 AND status = \$2/)
      expect(updates[0]![0]).toMatch(/RETURNING id/)
      expect(updates[0]![1]).toEqual([1, "running"])
      expect(updates[1]![1]).toEqual([2, "pending"])

      // Queue rows are removed for each swept build, salvaging the stored check data.
      const deletes = queriesMatching(client, /DELETE FROM task_queue/)
      expect(deletes).toHaveLength(2)
      expect(deletes[0]![1]).toEqual([1])
      expect(deletes[1]![1]).toEqual([2])

      // One VCS status post per swept build, carrying the salvaged check data.
      expect(postBuildFailedStatus).toHaveBeenCalledTimes(2)
      expect(postBuildFailedStatus).toHaveBeenCalledWith(
        mockScreenshotTest,
        expect.stringContaining("stuck"),
        expect.objectContaining({ gitlabCheckData }),
      )
    })

    it("uses COALESCE(last_progress_at, updated_at) for the running-stuck predicate", async () => {
      const { andWhere } = mockDatabaseForSweep([], [])
      mockPoolClient()

      await sweepStuckBuilds()

      expect(andWhere).toHaveBeenCalledWith(
        expect.stringContaining("COALESCE(test.last_progress_at, test.updated_at)"),
        expect.objectContaining({ minutes: expect.any(Number) }),
      )
    })

    it("skips queue cleanup and the VCS post when the conditional UPDATE returns no row (concurrent sweeper won)", async () => {
      const stuckRunningBuild = { id: 1, status: "running", updatedAt: staleDate }
      mockDatabaseForSweep([stuckRunningBuild], [])

      // Another sweeper already flipped the build: the conditional UPDATE matches nothing.
      const client = mockPoolClient(() => ({ rows: [], rowCount: 0 }))

      const count = await sweepStuckBuilds()

      expect(count).toBe(0)
      expect(queriesMatching(client, /DELETE FROM task_queue/)).toHaveLength(0)
      expect(postBuildFailedStatus).not.toHaveBeenCalled()
    })

    it("does nothing when no builds are stuck", async () => {
      mockDatabaseForSweep([], [])
      const client = mockPoolClient()

      const count = await sweepStuckBuilds()

      expect(count).toBe(0)
      expect(queriesMatching(client, /UPDATE screenshot_tests/)).toHaveLength(0)
      expect(postBuildFailedStatus).not.toHaveBeenCalled()
    })

    it("propagates database errors", async () => {
      const originalError = log.error
      log.error = vi.fn()
      /* eslint-disable @typescript-eslint/no-explicit-any */
      vi.mocked(Database).mockResolvedValue({
        getRepository: () => ({
          createQueryBuilder: () => ({
            where: vi.fn().mockReturnThis(),
            andWhere: vi.fn().mockReturnThis(),
            getMany: vi.fn().mockRejectedValue(new Error("Database error")),
          }),
        }),
      } as any)
      /* eslint-enable @typescript-eslint/no-explicit-any */

      await expect(sweepStuckBuilds()).rejects.toThrow("Database error")
      log.error = originalError
    })

    it("fires from the dedicated sweep timer even while a task is in flight", async () => {
      vi.useFakeTimers()
      try {
        // Occupy the worker with an already-claimed task whose processing hangs (the baseline
        // dependency check never resolves), so currentTaskId stays set for the duration. The
        // same Database mock serves the sweep's query-builder reads with no stuck builds.
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
        const getMany = vi.fn().mockResolvedValue([])
        const queryBuilder: any = { getMany }
        queryBuilder.where = vi.fn().mockReturnValue(queryBuilder)
        queryBuilder.andWhere = vi.fn().mockReturnValue(queryBuilder)
        vi.mocked(Database).mockResolvedValue({
          getRepository: () => ({
            createQueryBuilder: () => queryBuilder,
            findOneBy: vi.fn(() => new Promise(() => undefined)),
          }),
        } as any)
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
        mockPoolClient()
        void startTask({
          id: 999_451,
          task_type: "ingest_storybook",
          screenshot_test_id: 123,
          data: { projectId: "test-project", uploadId: "test-upload" },
          attempts: 1,
        })

        const timer = startStuckBuildSweepTimer()
        try {
          expect(getMany).not.toHaveBeenCalled()
          // One minute later the dedicated timer fires and the sweep runs, even though the
          // worker is busy (the idle poll tick would never have fired).
          await vi.advanceTimersByTimeAsync(60_000)
          expect(getMany).toHaveBeenCalled()
        } finally {
          clearInterval(timer)
        }
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("reclaimOrphanedBuilds (#451)", () => {
    it("requeues an orphaned build when its task still has attempt budget", async () => {
      mockDatabaseForSweep([], [])
      const client = mockPoolClient((sql) => {
        if (sql.includes("SELECT id FROM screenshot_tests")) {
          return { rows: [{ id: 42 }], rowCount: 1 }
        }
        if (sql.includes("SELECT id, attempts FROM task_queue")) {
          return { rows: [{ id: 7, attempts: 1 }], rowCount: 1 }
        }
        return undefined
      })

      await reclaimOrphanedBuilds("worker-a")

      // The orphan query is scoped to this worker's id.
      const selects = queriesMatching(client, /SELECT id FROM screenshot_tests/)
      expect(selects[0]![1]).toEqual(["worker-a"])

      // The task lock is cleared so any worker can pick it up again...
      const unlocks = queriesMatching(client, /UPDATE task_queue SET locked_at = NULL/)
      expect(unlocks).toHaveLength(1)
      expect(unlocks[0]![1]).toEqual([7])

      // ...and the build flips back to pending (conditionally: only if still running).
      const updates = queriesMatching(client, /UPDATE screenshot_tests/)
      expect(updates).toHaveLength(1)
      expect(updates[0]![0]).toContain("'pending'")
      expect(updates[0]![0]).toMatch(/WHERE id = \$1 AND status = 'running'/)
      expect(updates[0]![1]).toEqual([42])

      expect(queriesMatching(client, /DELETE FROM task_queue/)).toHaveLength(0)
      expect(postBuildFailedStatus).not.toHaveBeenCalled()
    })

    it("fails the build and posts the VCS status when the attempt budget is exhausted", async () => {
      const { findOneBy } = mockDatabaseForSweep([], [])
      const githubCheckData = { owner: "o", repo: "r", checkRunId: 5, installationId: 6 }
      const client = mockPoolClient((sql) => {
        if (sql.includes("SELECT id FROM screenshot_tests")) {
          return { rows: [{ id: 42 }], rowCount: 1 }
        }
        if (sql.includes("SELECT id, attempts FROM task_queue")) {
          // WORKER_MAX_TASK_ATTEMPTS defaults to 3; this task has burned its budget.
          return { rows: [{ id: 7, attempts: 3 }], rowCount: 1 }
        }
        if (sql.includes("UPDATE screenshot_tests")) {
          return { rows: [{ id: 42 }], rowCount: 1 }
        }
        if (sql.includes("DELETE FROM task_queue")) {
          return { rows: [{ data: { githubCheckData } }], rowCount: 1 }
        }
        return undefined
      })

      await reclaimOrphanedBuilds("worker-a")

      // The build is failed conditionally (only if still running), not requeued.
      const updates = queriesMatching(client, /UPDATE screenshot_tests/)
      expect(updates).toHaveLength(1)
      expect(updates[0]![0]).toContain("'failed'")
      expect(updates[0]![0]).toMatch(/WHERE id = \$1 AND status = 'running'/)
      expect(queriesMatching(client, /UPDATE task_queue SET locked_at = NULL/)).toHaveLength(0)

      // The dead task row is removed and its check data salvaged for the status post.
      const deletes = queriesMatching(client, /DELETE FROM task_queue/)
      expect(deletes).toHaveLength(1)
      expect(deletes[0]![1]).toEqual([7])

      expect(findOneBy).toHaveBeenCalledWith({ id: 42 })
      expect(postBuildFailedStatus).toHaveBeenCalledTimes(1)
      expect(postBuildFailedStatus).toHaveBeenCalledWith(
        mockScreenshotTest,
        expect.stringContaining("orphaned"),
        expect.objectContaining({ githubCheckData }),
      )
    })

    it("fails the build and posts the VCS status when the queue row is gone", async () => {
      mockDatabaseForSweep([], [])
      const client = mockPoolClient((sql) => {
        if (sql.includes("SELECT id FROM screenshot_tests")) {
          return { rows: [{ id: 42 }], rowCount: 1 }
        }
        if (sql.includes("UPDATE screenshot_tests")) {
          return { rows: [{ id: 42 }], rowCount: 1 }
        }
        return undefined
      })

      await reclaimOrphanedBuilds("worker-a")

      const updates = queriesMatching(client, /UPDATE screenshot_tests/)
      expect(updates).toHaveLength(1)
      expect(updates[0]![0]).toContain("'failed'")
      expect(queriesMatching(client, /DELETE FROM task_queue/)).toHaveLength(0)
      expect(postBuildFailedStatus).toHaveBeenCalledTimes(1)
    })

    it("does nothing when there are no orphaned builds", async () => {
      mockDatabaseForSweep([], [])
      const client = mockPoolClient()

      await reclaimOrphanedBuilds("worker-a")

      expect(queriesMatching(client, /UPDATE/)).toHaveLength(0)
      expect(postBuildFailedStatus).not.toHaveBeenCalled()
    })
  })

  describe("failBuildBeforeExit (#451)", () => {
    it("conditionally fails the build, deletes the queue row, and posts the VCS status", async () => {
      const client = mockPoolClient()
      const checkData = {
        gitlabCheckData: { projectId: 7, commitSha: "sha", gitlabHost: "https://gitlab.com" },
      }

      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      await failBuildBeforeExit(123, 55, mockScreenshotTest as any, checkData)

      // The status flip is conditional so it can never clobber a terminal status.
      const updates = queriesMatching(client, /UPDATE screenshot_tests/)
      expect(updates).toHaveLength(1)
      expect(updates[0]![0]).toMatch(/WHERE id = \$1 AND status IN \('pending', 'running'\)/)
      expect(updates[0]![1]).toEqual([123])

      // The wedged build is non-retryable: its queue row is removed.
      const deletes = queriesMatching(client, /DELETE FROM task_queue/)
      expect(deletes).toHaveLength(1)
      expect(deletes[0]![1]).toEqual([55])

      expect(postBuildFailedStatus).toHaveBeenCalledWith(
        mockScreenshotTest,
        expect.any(String),
        checkData,
      )
    })

    it("skips the queue delete when no task queue id is known", async () => {
      const client = mockPoolClient()

      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      await failBuildBeforeExit(123, undefined, mockScreenshotTest as any)

      expect(queriesMatching(client, /UPDATE screenshot_tests/)).toHaveLength(1)
      expect(queriesMatching(client, /DELETE FROM task_queue/)).toHaveLength(0)
      expect(postBuildFailedStatus).toHaveBeenCalled()
    })

    it("is bounded by the fatal failsafe timeout: a wedged render still exits even if the DB hangs", async () => {
      const originalError = log.error
      const originalWarn = log.warn
      const originalFatal = log.fatal
      const fatalMock = vi.fn()
      log.error = vi.fn()
      log.warn = vi.fn()
      log.fatal = fatalMock
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
      try {
        // Earlier tests replace the S3Client mock implementation (clearAllMocks does not restore
        // it); reinstate the default send-backed client so the download phase succeeds.
        vi.mocked(S3Client).mockImplementation(function (this: { send: typeof mockSend }) {
          this.send = mockSend
        } as unknown as typeof S3Client)

        // The database hangs, so failBuildBeforeExit never settles; the failsafe timer
        // (WORKER_FATAL_FAILSAFE_TIMEOUT_MS, mocked to 300ms — 5s in production) must still
        // bound the exit.
        vi.mocked(DatabasePool).mockImplementation(() => new Promise(() => undefined))

        // A story wedged beyond recovery: it never settles, even when its session is closed.
        vi.mocked(captureStoryWithRetry).mockImplementationOnce(() => new Promise(() => undefined))

        // Swallow the (never-delivered) rejection; the promise dangles by design (withTimeout
        // never resolves while the wedged render holds resources).
        void ingestStorybook("test-project", 123, "test-upload", undefined, undefined, 55).catch(
          () => undefined,
        )

        // BUILD_TIMEOUT_MS (50ms) fires the abort, BUILD_ABORT_GRACE_MS (500ms) expires without
        // the render unwinding -> onUnrecoverable runs and starts the failsafe race.
        await vi.waitFor(() => expect(fatalMock).toHaveBeenCalled(), { timeout: 3000 })

        // One failsafe interval later the race resolves via the timer and the worker exits even
        // though the DB write never completed — the exit is never delayed indefinitely.
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1), { timeout: 3000 })
      } finally {
        exitSpy.mockRestore()
        log.error = originalError
        log.warn = originalWarn
        log.fatal = originalFatal
      }
    })
  })

  // NOTE: must run last within this file: handleShutdownSignal() flips the module-level
  // `shuttingDown` flag, after which the worker accepts no new tasks.
  describe("graceful shutdown (#451)", () => {
    it("resets the owned running build to pending after releasing the task lock", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
      try {
        const client = mockPoolClient()

        handleShutdownSignal("SIGTERM")
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0))

        const updates = queriesMatching(client, /UPDATE screenshot_tests/)
        expect(updates).toHaveLength(1)
        expect(updates[0]![0]).toContain("SET status = 'pending', worker_id = NULL")
        expect(updates[0]![0]).toMatch(/WHERE status = 'running' AND worker_id = \$1/)
        expect(updates[0]![1]).toEqual([WORKER_ID])
      } finally {
        exitSpy.mockRestore()
      }
    })
  })
})
