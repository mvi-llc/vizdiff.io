import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import type { WriteStream } from "node:fs"
import { PNG } from "pngjs"
import { TestResult, ScreenshotTest, screenshotKey } from "shared"
import { Readable } from "stream"
import type { Repository } from "typeorm"
import { expect, describe, it, vi, beforeEach } from "vitest"
import type { Browser } from "webdriverio"

import type { BrowserPool, PooledSession } from "./browserPool"
import {
  captureStory,
  finalizeStory,
  getSessionCaptureState,
  processStoryWithRetry,
  renderStory,
} from "./stories"
import { createMockBrowser, defaultMockPageState } from "./testing/mockBrowser"
import type { Story } from "./types"

/**
 * Test suite for the screenshot comparison functionality.
 *
 * The renderStory function:
 * 1. Takes a screenshot of a Storybook story
 * 2. Uploads it to S3
 * 3. Downloads the baseline image (if it exists)
 * 4. Compares the images and determines if there are changes
 * 5. Saves the results to the database
 *
 * Since issue #456 the work is split into a session-holding capture phase (captureStory) and a
 * browser-free finalize phase (finalizeStory); renderStory is their sequential composition.
 * processStoryWithRetry adds session checkout, health probing, infra-error classification/retry
 * (capture only), and failed-result recording (issues #450/#454/#456).
 */

// Mock function declarations for all external dependencies
const mockSend = vi.fn()
// Since issue #456 per-story results are persisted via `upsert` (idempotent on the unique
// (screenshot_test_id, story_id) key) instead of `save`; the mock mirrors TypeORM's
// InsertResult shape so the entity id copy-back in upsertTestResult() works.
const mockTestResultSave = vi.fn()
const upsertResult = (data: TestResult) => ({
  // `id` is unset on a freshly-constructed entity despite its non-optional type.
  identifiers: [{ id: (data.id as number | undefined) ?? 1 }],
  generatedMaps: [],
  raw: [],
})

/**
 * Mock S3 client for testing file uploads/downloads
 * - GetObjectCommand: Downloads baseline images
 * - PutObjectCommand: Uploads new screenshots and diff images
 */
// vitest 4 constructs these mocks with `new`, so they must be real
// classes/constructors rather than arrow-function factories (arrows are not
// constructable). The source code does `new S3Client(...)`,
// `new GetObjectCommand(...)`, and `new PutObjectCommand(...)`.
vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockSend
  }

  class MockGetObjectCommand {
    constructor(public input: { Bucket: string; Key: string }) {}
  }

  class MockPutObjectCommand {
    constructor(
      public input: { Bucket: string; Key: string; Body: Buffer | string; ContentType?: string },
    ) {}
  }

  return {
    S3Client: MockS3Client,
    GetObjectCommand: MockGetObjectCommand,
    PutObjectCommand: MockPutObjectCommand,
  }
})

/**
 * Creates a mock write stream that properly handles Node.js stream events.
 * This is crucial for testing the S3 download functionality which uses streams.
 */
function createMockWriteStream(): WriteStream {
  const handlers = new Map<string, Array<() => void>>()

  const writeStream = {
    on: vi.fn().mockImplementation((event: string, callback: () => void) => {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(callback)
      handlers.set(event, eventHandlers)
      return writeStream
    }),
    once: vi.fn().mockImplementation((event: string, callback: () => void) => {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.push(callback)
      handlers.set(event, eventHandlers)
      return writeStream
    }),
    removeListener: vi.fn().mockImplementation((event: string, callback: () => void) => {
      const eventHandlers = handlers.get(event) ?? []
      const index = eventHandlers.indexOf(callback)
      if (index !== -1) {
        eventHandlers.splice(index, 1)
        handlers.set(event, eventHandlers)
      }
      return writeStream
    }),
    removeAllListeners: vi.fn().mockImplementation((event?: string) => {
      if (event) {
        handlers.delete(event)
      } else {
        handlers.clear()
      }
      return writeStream
    }),
    pipe: vi.fn().mockImplementation((readableStream: Readable) => {
      // Simulate the pipe operation by reading from the stream
      readableStream.on("data", (chunk: Buffer) => {
        writeStream.write(chunk)
      })
      readableStream.on("end", () => {
        writeStream.end()
        const finishHandlers = handlers.get("finish") ?? []
        finishHandlers.forEach((handler) => handler())
      })
      return writeStream
    }),
    write: vi.fn(),
    end: vi.fn().mockImplementation(() => {
      const finishHandlers = handlers.get("finish") ?? []
      finishHandlers.forEach((handler) => handler())
      return true
    }),
    emit: vi.fn().mockImplementation((event: string) => {
      const eventHandlers = handlers.get(event) ?? []
      eventHandlers.forEach((handler) => handler())
      return true
    }),
    bytesWritten: 0,
    path: "",
    pending: false,
    writable: true,
  } as unknown as WriteStream
  return writeStream
}

/**
 * Mock filesystem operations
 * - readFile: Returns different mock data for baseline vs new images
 * - writeFile: Used for saving diff images
 * - mkdir/rm: Used for temp directory management
 */
vi.mock("node:fs", () => {
  const fs = {
    createWriteStream: () => createMockWriteStream(),
    createReadStream: vi.fn(),
    promises: {
      readFile: vi.fn((path: string) => {
        if (path.endsWith("-baseline.png")) {
          return Promise.resolve(Buffer.from("mock baseline image"))
        }
        if (path.endsWith(".png")) {
          return Promise.resolve(Buffer.from("mock new image"))
        }
        return Promise.resolve(Buffer.from("mock image data"))
      }),
      writeFile: vi.fn(),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      unlink: () => Promise.resolve(),
    },
  }
  return { default: fs, promises: fs.promises }
})

// Remove the separate fs/promises mock since it's now part of the fs mock
vi.unmock("node:fs/promises")

/**
 * Mock pixelmatch (image comparison library)
 * Returns:
 * - 0 when images are identical
 * - width * height (all pixels different) when images differ
 *
 * Hoisted into a vi.fn so tests can assert whether pixelmatch ran at all (the Buffer.equals
 * stabilization fast path, issue #456) and force a "still changing" comparison via
 * mockImplementationOnce.
 */
const mockPixelmatch = vi.hoisted(() =>
  vi.fn(
    (
      img1: Buffer,
      img2: Buffer,
      _output: Buffer,
      width: number,
      height: number,
      _options?: unknown,
    ): number => {
      // If both buffers contain the same data, return 0 differences
      if (img1.toString() === img2.toString()) {
        return 0
      }
      // Otherwise return width * height (all pixels different)
      return width * height
    },
  ),
)
vi.mock("pixelmatch", () => ({ default: mockPixelmatch }))

/**
 * Mock PNG operations with different behaviors for test scenarios:
 * 1. Unchanged test: Both images have same dimensions and content
 * 2. Dimension mismatch test: Baseline is 200x100, new image is 100x100
 * 3. New image test: No special handling needed
 */
vi.mock("pngjs", () => {
  let currentTest = ""

  class MockPNG {
    width: number
    height: number
    data: Buffer

    constructor(options?: { width?: number; height?: number }) {
      this.width = options?.width ?? 100
      this.height = options?.height ?? 100
      this.data = Buffer.alloc(this.width * this.height * 4)
    }

    static get sync() {
      return {
        read: (buffer: Buffer) => {
          // For dimension mismatch test, return different sized images
          if (currentTest === "dimension_mismatch" && buffer.toString() === "mock baseline image") {
            return {
              width: 200,
              height: 100,
              data: Buffer.from([0, 0, 0, 255]),
            }
          }
          // For all other cases, return standard size images
          return {
            width: 100,
            height: 100,
            data: Buffer.from([0, 0, 0, 255]),
          }
        },
        write: (_png: MockPNG) => Buffer.from("mock diff image"),
      }
    }

    static setTestMode(mode: string): void {
      currentTest = mode
    }
  }

  return { PNG: MockPNG }
})

describe("stories", () => {
  // Mock story data that would come from Storybook
  const mockStory = {
    id: "stories-components-teststory--mycomponent",
    kind: "stories/components/TestStory",
    name: "My Component",
    title: "stories/components/TestStory",
    importPath: "./stories/Test.stories.tsx",
    componentPath: "./stories/Test.stories.tsx",
    tags: ["dev", "test"],
  }

  // Mock ScreenshotTest instance
  const mockScreenshotTest = new ScreenshotTest()
  Object.assign(mockScreenshotTest, {
    id: 123,
    status: "pending",
    buildNumber: 1,
    commitSha: "1234567890123456789012345678901234567890",
    branch: "main",
    uploadId: "abcdef",
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // Mock WebdriverIO browser instance for taking screenshots. The shared helper's `waitUntil`
  // actually polls its predicate, and `execute` runs page functions against a fake window/document
  // driven by the mutable `mockPageState` (defaulting to "story render completed immediately", so
  // the story-readiness gate added in issue #458 passes without any extra scripting here).
  const { browser: mockBrowser, state: mockPageState, fns: mockBrowserFns } = createMockBrowser()
  const mockBrowserUrl = mockBrowserFns.url
  const mockBrowserSaveScreenshot = mockBrowserFns.saveScreenshot
  const mockBrowserSetViewport = mockBrowserFns.setViewport
  const mockBrowserPause = mockBrowserFns.pause

  // Make the mock browser globally available (required by processStory)
  global.browser = mockBrowser

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks()

    // Reset the scripted page state (individual tests mutate it)
    Object.assign(mockPageState, defaultMockPageState())

    // Reset the per-session viewport skip cache (issue #474): the shared mockBrowser object
    // persists across tests, so a cached viewport would otherwise leak between them.
    delete getSessionCaptureState(mockBrowser).lastViewport

    // Reset PNG mock state
    ;(PNG as unknown as { setTestMode(mode: string): void }).setTestMode("")

    // Setup S3 mock behavior
    mockSend.mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        // Extract uploadId from the key path
        const key = command.input.Key ?? ""
        const match = /screenshots\/([\w-]+)\//.exec(key)
        const uploadId = match?.[1]
        if (uploadId === "xyz789") {
          // Return mock stream with baseline image data
          return {
            Body: new Readable({
              read() {
                this.push(Buffer.from("mock baseline image"))
                this.push(null)
              },
            }),
          }
        }
        throw new Error(`Baseline not found for uploadId: ${uploadId}`)
      }
      if (command instanceof PutObjectCommand) {
        return command
      }
      return {}
    })
  })

  /**
   * Test case 1: New story without baseline
   * Verifies that:
   * - Screenshot is taken and uploaded to S3
   * - No baseline comparison is attempted
   * - Result is marked as "new"
   */
  it("should process a new story without baseline", async () => {
    const testResult = await renderStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
          upsertResult(data),
        ),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    // Verify browser interactions
    expect(mockBrowserUrl).toHaveBeenCalledWith(
      "http://localhost:9009/iframe.html?id=stories-components-teststory--mycomponent",
    )
    expect(mockBrowserSaveScreenshot).toHaveBeenCalled()

    // Verify S3 upload
    type S3CommandInput = {
      input: {
        Bucket: string
        Key: string
        Body?: Buffer | string
        ContentType?: string
      }
    }
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining<S3CommandInput>({
        input: {
          Bucket: "test-bucket",
          Key: screenshotKey("test-project", "123", "stories-components-teststory--mycomponent"),
          Body: expect.any(Buffer) as Buffer,
          ContentType: "image/png",
        },
      }),
    )

    // Verify test result
    expect(testResult.changeStatus).toBe("new")
    expect(testResult.diffRatio).toBe(0)
    expect(testResult.name).toBe("components/TestStory/My Component")
    expect(testResult.storyId).toBe("stories-components-teststory--mycomponent")
    expect(testResult.screenshotTest.id).toBe(123)
  })

  /**
   * Test case 2: Story matches baseline
   * Verifies that:
   * - Screenshot is taken and uploaded
   * - Baseline is downloaded from S3
   * - Images are compared and found identical
   * - Result is marked as "unchanged"
   */
  it("should process a story with no change from baseline", async () => {
    ;(PNG as unknown as { setTestMode(mode: string): void }).setTestMode("unchanged")
    const baseTestResult = new TestResult()
    Object.assign(baseTestResult, {
      id: 789,
      name: "Test Story",
      storyId: "test-story",
      screenshotTestId: 456,
      screenshotTest: {
        id: 456,
        uploadId: "xyz789",
      },
      baselineImageUrl: "https://test-bucket.s3.amazonaws.com/baseline.png",
      newImageUrl: "https://test-bucket.s3.amazonaws.com/new.png",
      diffImageUrl: "https://test-bucket.s3.amazonaws.com/diff.png",
      diffRatio: 0,
      changeStatus: "new",
    })

    const testResult = await renderStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      baseTestResult,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "xyz789",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
          upsertResult(data),
        ),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    expect(testResult.changeStatus).toBe("unchanged")
    expect(testResult.diffRatio).toBeLessThan(0.001)
  })

  /**
   * Test case 3: Image dimension mismatch
   * Verifies that:
   * - When baseline image has different dimensions (200x100 vs 100x100)
   * - Result is marked as "changed" without pixel comparison
   * - Diff ratio is set to 1 (maximum difference)
   */
  it("should handle baseline image dimension mismatch", async () => {
    ;(PNG as unknown as { setTestMode(mode: string): void }).setTestMode("dimension_mismatch")
    const baseTestResult = new TestResult()
    Object.assign(baseTestResult, {
      id: 789,
      name: "Test Story",
      storyId: "test-story",
      screenshotTestId: 456,
      screenshotTest: {
        id: 456,
        uploadId: "xyz789",
      },
      baselineImageUrl: "https://test-bucket.s3.amazonaws.com/baseline.png",
      newImageUrl: "https://test-bucket.s3.amazonaws.com/new.png",
      diffImageUrl: "https://test-bucket.s3.amazonaws.com/diff.png",
      diffRatio: 0,
      changeStatus: "unchanged",
    })

    const testResult = await renderStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      baseTestResult,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "xyz789",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
          upsertResult(data),
        ),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    expect(testResult.changeStatus).toBe("changed")
    expect(testResult.diffRatio).toBe(1)
  })

  /**
   * Test case 4: Screenshot retry on failure
   * Verifies that:
   * - First screenshot attempt fails
   * - Code waits 1 second
   * - Second attempt succeeds
   * - One more attempt for stability check
   * - Processing continues normally
   */
  it("should retry screenshot on failure", async () => {
    mockBrowserSaveScreenshot
      .mockRejectedValueOnce(new Error("Screenshot failed"))
      .mockResolvedValueOnce(Buffer.from("mock screenshot"))
      .mockResolvedValueOnce(Buffer.from("mock screenshot 2")) // For stability check

    await renderStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
          upsertResult(data),
        ),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    // Should be called 3 times:
    // 1. Initial attempt (fails)
    // 2. Retry attempt (succeeds)
    // 3. Stability check attempt (succeeds)
    expect(mockBrowserSaveScreenshot).toHaveBeenCalledTimes(3)
    expect(mockBrowserPause).toHaveBeenCalledWith(1000) // For retry delay
    // Adaptive cadence (issue #474): the first stability check is rAF-spaced and sleep-free, so
    // no WORKER_STABILIZE_INTERVAL_MS pause occurs for a story that settles immediately.
    expect(mockBrowserPause).not.toHaveBeenCalledWith(250)
  })

  /**
   * renderStory THROWS on render failure (issue #454 restructure): error recording and retry
   * policy live in processStoryWithRetry, so renderStory must surface the raw error.
   */
  it("throws on a render failure instead of recording a failed result", async () => {
    // Make navigation to the story fail, so captureStableScreenshot throws.
    mockBrowserUrl.mockRejectedValueOnce(new Error("navigation blew up"))

    await expect(
      renderStory({
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser: mockBrowser,
      }),
    ).rejects.toThrow("navigation blew up")

    // Nothing was persisted or uploaded for the failed render.
    expect(mockTestResultSave).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalledWith(expect.any(PutObjectCommand))
  })

  /**
   * Test case 5: Tall content grows the viewport (issue #146)
   * Verifies that:
   * - When the page's measured content height exceeds the viewport, the viewport is grown so the
   *   full content is captured (the "Getting Started" vertical-cutoff fix)
   * - The grow happens with the full content height, not the initial 900px default
   */
  it("should grow the viewport to fit tall content", async () => {
    const TALL_CONTENT_HEIGHT = 4000
    // The content height is measured twice: the initial pre-stabilization measurement under-reports
    // (the layout has not settled), and the post-stabilization measurement reports the true tall
    // height. This mirrors the issue #146 scenario where the content height is computed too early.
    // The mock page consumes one array element per measuring execute call (the last one sticks).
    // The initial 1500px measurement exceeds the 900px story viewport, so the issue #456 skip
    // guard does not apply and the authoritative post-stabilization pass must still run.
    mockPageState.contentHeight = [1500, TALL_CONTENT_HEIGHT]

    await renderStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
          upsertResult(data),
        ),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    // The viewport should have been set to the full content height (>= 4000), proving the
    // screenshot is no longer clipped to the initial 900px viewport.
    expect(mockBrowserSetViewport).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1200, height: TALL_CONTENT_HEIGHT }),
    )
  })

  /**
   * Issue #456 (A3): the post-stabilization height re-measure is skipped ONLY when the story
   * stabilized on the first attempt AND the initially measured content height fit within the
   * story's viewport. Both guard conditions are exercised: skip when they hold, keep the
   * authoritative pass when either fails.
   */
  describe("post-stabilization height re-measure skip (#456)", () => {
    function baseRenderInfo() {
      return {
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser: mockBrowser,
      }
    }

    it("skips the second measurement when stabilized on attempt 1 and the content fit", async () => {
      // Initial measurement (800) fits the 900px viewport; the default mock screenshots are
      // byte-identical, so the story stabilizes on attempt 1. If the second (authoritative)
      // measurement ran, it would read 4000 and grow the viewport — it must not.
      mockPageState.contentHeight = [800, 4000]

      await renderStory(baseRenderInfo())

      expect(mockBrowserSetViewport).not.toHaveBeenCalledWith(
        expect.objectContaining({ height: 4000 }),
      )
    })

    it("keeps the authoritative pass when stabilization took more than one attempt", async () => {
      // Content fits initially (800 <= 900), but the first stability comparison reports a
      // still-changing page (differing screenshot bytes + a forced pixelmatch mismatch), so
      // stabilization needs a second attempt and the guard must NOT skip the re-measure.
      mockPageState.contentHeight = [800, 4000]
      mockBrowserSaveScreenshot
        .mockResolvedValueOnce(Buffer.from("frame 1"))
        .mockResolvedValueOnce(Buffer.from("frame 2"))
      mockPixelmatch.mockImplementationOnce(() => 10_000) // attempt 1: everything changed

      await renderStory(baseRenderInfo())

      // The second measurement ran and grew the viewport to the settled 4000px height.
      expect(mockBrowserSetViewport).toHaveBeenCalledWith(
        expect.objectContaining({ width: 1200, height: 4000 }),
      )
    })
  })

  /**
   * Issue #456 (A3): when consecutive stabilization screenshots are byte-identical, the loop
   * must treat them as identical (diffRatio 0) WITHOUT decoding PNGs or running pixelmatch.
   */
  describe("stabilization Buffer.equals fast path (#456)", () => {
    it("skips pixelmatch when consecutive screenshots are byte-identical", async () => {
      // Default mock screenshots are identical, and a new story (no baseline) does no baseline
      // diff — so pixelmatch must never run at all.
      await renderStory({
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser: mockBrowser,
      })

      expect(mockPixelmatch).not.toHaveBeenCalled()
    })

    it("still runs pixelmatch when consecutive screenshots differ", async () => {
      mockBrowserSaveScreenshot
        .mockResolvedValueOnce(Buffer.from("frame 1"))
        .mockResolvedValueOnce(Buffer.from("frame 2"))

      await renderStory({
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser: mockBrowser,
      })

      expect(mockPixelmatch).toHaveBeenCalled()
    })
  })

  /**
   * Issue #474: adaptive stabilization cadence. The first stability check is rAF-spaced and
   * sleep-free; only a nonzero first diff falls back to paced checks with backoff
   * (min(interval, 100) -> interval -> 2x interval capped at 500 ms).
   */
  describe("adaptive stabilization cadence (#474)", () => {
    function renderInfo() {
      return {
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser: mockBrowser,
      }
    }

    it("captures with zero pauses when the first two screenshots are identical", async () => {
      // Default mock: screenshots are byte-identical and the content fits the viewport, so the
      // story stabilizes on the rAF-spaced first attempt with no sleeps anywhere in capture.
      await renderStory(renderInfo())

      expect(mockBrowserPause).not.toHaveBeenCalled()
    })

    it("falls back to backoff-paced checks when the page keeps changing", async () => {
      // Every capture returns distinct bytes and the first three comparisons report a fully
      // changed page, so the loop must pace attempts 2-4 with the backoff sequence.
      mockBrowserSaveScreenshot
        .mockResolvedValueOnce(Buffer.from("frame 0")) // initial screenshot
        .mockResolvedValueOnce(Buffer.from("frame 1")) // attempt 1 (rAF-spaced)
        .mockResolvedValueOnce(Buffer.from("frame 2")) // attempt 2
        .mockResolvedValueOnce(Buffer.from("frame 3")) // attempt 3
        .mockResolvedValueOnce(Buffer.from("frame 4")) // attempt 4 (settles)
      mockPixelmatch
        .mockImplementationOnce(() => 10_000) // attempt 1: still changing
        .mockImplementationOnce(() => 10_000) // attempt 2: still changing
        .mockImplementationOnce(() => 10_000) // attempt 3: still changing

      await renderStory(renderInfo())

      // min(WORKER_STABILIZE_INTERVAL_MS, 100), WORKER_STABILIZE_INTERVAL_MS, 2x capped at 500.
      expect(mockBrowserPause.mock.calls.map((call) => call[0] as number)).toEqual([100, 250, 500])
    })
  })

  /**
   * Issue #474: the initial content-height measurement rides the readiness snapshot instead of a
   * separate execute round-trip, and setViewport is skipped when the viewport is unchanged from
   * the session's previous story (invalidated automatically when the pool swaps in a new Browser
   * object).
   */
  describe("round-trip batching and viewport skip cache (#474)", () => {
    function infoWith(browser: Browser, story: Story = mockStory) {
      return {
        story,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser,
      }
    }

    it("batches the initial height probe into the readiness poll (no separate measure)", async () => {
      // Default state: readiness succeeds on the first poll, the story stabilizes on attempt 1,
      // and the settled re-measure is skipped. Capture therefore performs exactly three execute
      // round-trips: readiness snapshot, CSS injection, and the rAF-spaced tick — with no
      // standalone content-height measurement before stabilization.
      await captureStory(infoWith(mockBrowser))

      expect(mockBrowserFns.execute).toHaveBeenCalledTimes(3)
    })

    it("uses the readiness-snapshot height for the initial viewport fit", async () => {
      // The first (readiness-snapshot) measurement reports tall content, so the initial viewport
      // adjustment must grow the viewport before stabilization even begins.
      mockPageState.contentHeight = [3000, 3000]

      await captureStory(infoWith(mockBrowser))

      expect(mockBrowserSetViewport).toHaveBeenCalledWith(
        expect.objectContaining({ width: 1200, height: 3000 }),
      )
    })

    it("skips setViewport when the viewport is unchanged on the same session", async () => {
      const { browser, fns } = createMockBrowser()

      await renderStory(infoWith(browser))
      await renderStory(infoWith(browser))

      // Two stories at the same default viewport: one BiDi setViewport call total.
      expect(fns.setViewport).toHaveBeenCalledTimes(1)
    })

    it("re-applies setViewport when the story viewport differs", async () => {
      const { browser, fns } = createMockBrowser()
      const smallStory = {
        ...mockStory,
        id: "stories-components-teststory--small",
        parameters: {
          viewport: {
            viewports: {
              small: {
                name: "small",
                type: "mobile" as const,
                styles: { width: "600px", height: "400px" },
              },
            },
            defaultViewport: "small",
          },
        },
      }

      await renderStory(infoWith(browser))
      await renderStory(infoWith(browser, smallStory))

      expect(fns.setViewport).toHaveBeenCalledTimes(2)
      expect(fns.setViewport).toHaveBeenLastCalledWith({
        width: 600,
        height: 400,
        devicePixelRatio: 1,
      })
    })

    it("re-applies setViewport on a fresh Browser object (pool replace)", async () => {
      // BrowserPool.replace() swaps a brand-new Browser instance into the session; the WeakMap
      // keying must invalidate the cache so the fresh browser gets its viewport set.
      const first = createMockBrowser()
      const second = createMockBrowser()

      await renderStory(infoWith(first.browser))
      await renderStory(infoWith(second.browser))

      expect(first.fns.setViewport).toHaveBeenCalledTimes(1)
      expect(second.fns.setViewport).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * Test case 6: Missing baseline handling
   * Verifies that:
   * - When S3 fails to provide baseline image
   * - Process continues gracefully
   * - Result is marked as "new"
   */
  it("should handle missing baseline gracefully", async () => {
    const baseTestResult = new TestResult()
    Object.assign(baseTestResult, {
      id: 789,
      name: "Test Story",
      storyId: "test-story",
      screenshotTestId: 456,
      screenshotTest: {
        id: 456,
        uploadId: "xyz789",
      },
      baselineImageUrl: "https://test-bucket.s3.amazonaws.com/baseline.png",
      newImageUrl: "https://test-bucket.s3.amazonaws.com/new.png",
      diffImageUrl: "https://test-bucket.s3.amazonaws.com/diff.png",
      diffRatio: 0,
      changeStatus: "unchanged",
    })

    // Mock S3 error when fetching baseline
    mockSend.mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        throw new Error("Baseline not found")
      }
      if (command instanceof PutObjectCommand) {
        return { input: command.input }
      }
      return {}
    })

    const testResult = await renderStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      baseTestResult,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: mockScreenshotTest.uploadId,
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
          upsertResult(data),
        ),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    expect(testResult.changeStatus).toBe("new")
    expect(testResult.diffRatio).toBe(0)
  })

  /**
   * processStoryWithRetry (issues #450/#454): session checkout + health probing + infra-error
   * retry + failure recording around renderStory. Driven with a single-session fake pool whose
   * release() mimics the real pool's threshold-based replacement.
   */
  describe("processStoryWithRetry", () => {
    /** Single-session fake pool; release() replaces after `maxConsecutiveInfraFailures`. */
    function createFakePool(opts: { maxConsecutiveInfraFailures?: number } = {}) {
      const session: PooledSession = {
        id: 0,
        browser: mockBrowser,
        storiesRendered: 0,
        consecutiveInfraFailures: 0,
      }
      const replace = vi.fn(async (_session: PooledSession, _reason: string) => {
        session.storiesRendered = 0
        session.consecutiveInfraFailures = 0
      })
      const max = opts.maxConsecutiveInfraFailures ?? 0
      const acquire = vi.fn(async () => session)
      const release = vi.fn(async (released: PooledSession) => {
        if (max > 0 && released.consecutiveInfraFailures >= max) {
          await replace(released, "infra-failures")
        }
      })
      const pool = {
        size: 1,
        sessions: [session],
        acquire,
        release,
        replace,
        setSessionInit: vi.fn(),
        destroyAll: vi.fn(async () => undefined),
      } as unknown as BrowserPool
      return { pool, session, replace, acquire, release }
    }

    function baseInfo(saved: TestResult[], pool: BrowserPool) {
      return {
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "123",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) => {
            saved.push(data)
            return upsertResult(data)
          }),
        } as unknown as Repository<TestResult>,
        pool,
      }
    }

    it("retries an infra failure and succeeds on the second attempt (session condemned)", async () => {
      // Attempt 1 burns a BiDi command timeout (infra-class); attempt 2 renders normally.
      mockBrowserUrl.mockRejectedValueOnce(
        new Error("Command browsingContext.setViewport with id 13494 timed out"),
      )
      const { pool, replace, acquire } = createFakePool({ maxConsecutiveInfraFailures: 1 })
      const saved: TestResult[] = []

      const testResult = await processStoryWithRetry(baseInfo(saved, pool))

      // Exactly ONE result row, and it is the successful render, not a failure.
      expect(testResult.changeStatus).toBe("new")
      expect(saved).toHaveLength(1)
      expect(saved[0]?.changeStatus).toBe("new")
      // The condemned session was replaced between the attempts.
      expect(replace).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }), "infra-failures")
      expect(acquire).toHaveBeenCalledTimes(2)
    })

    it("replaces a session that fails the health probe before rendering", async () => {
      // The probe's trivial execute hits a dead session once; the story then renders fine.
      mockBrowserFns.execute.mockRejectedValueOnce(new Error("invalid session id"))
      const { pool, replace } = createFakePool()
      const saved: TestResult[] = []

      const testResult = await processStoryWithRetry(baseInfo(saved, pool))

      expect(testResult.changeStatus).toBe("new")
      expect(replace).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }), "probe-failed")
      expect(saved).toHaveLength(1)
    })

    it("records a story-class failure immediately without retrying (StoryRenderError)", async () => {
      // Storybook reports the story threw: waitForStoryReady raises StoryRenderError.
      mockPageState.events = [{ type: "storyThrewException", message: "component blew up" }]
      const { pool, replace, acquire } = createFakePool({ maxConsecutiveInfraFailures: 1 })
      const saved: TestResult[] = []

      const testResult = await processStoryWithRetry(baseInfo(saved, pool))

      expect(testResult.changeStatus).toBe("failed")
      expect(testResult.errorKind).toBe("story-error")
      expect(testResult.errorMessage).toContain("component blew up")
      expect(testResult.newImageUrl).toBe("")
      expect(testResult.diffRatio).toBeNull()
      // No retry for a story-class failure, and the session is not condemned.
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(replace).not.toHaveBeenCalled()
      // Exactly one persisted row.
      expect(saved).toHaveLength(1)
      expect(saved[0]?.changeStatus).toBe("failed")
    })

    it("records the last infra kind once the attempt budget is exhausted", async () => {
      // Every attempt burns a command timeout (WORKER_STORY_MAX_ATTEMPTS defaults to 2). Two
      // `Once` rejections rather than a persistent one so the base implementation survives for
      // later tests (`clearAllMocks` clears calls, not implementations).
      mockBrowserUrl
        .mockRejectedValueOnce(new Error("Command script.callFunction with id 13493 timed out"))
        .mockRejectedValueOnce(new Error("Command script.callFunction with id 13493 timed out"))
      const { pool, acquire } = createFakePool({ maxConsecutiveInfraFailures: 1 })
      const saved: TestResult[] = []

      const testResult = await processStoryWithRetry(baseInfo(saved, pool))

      expect(acquire).toHaveBeenCalledTimes(2)
      expect(testResult.changeStatus).toBe("failed")
      expect(testResult.errorKind).toBe("browser-timeout")
      expect(testResult.errorMessage).toContain("timed out")
      expect(saved).toHaveLength(1)
    })

    it("records an S3 upload failure as a failed storage result without re-capturing", async () => {
      // Screenshot capture succeeds, but every PutObjectCommand send rejects.
      mockSend.mockImplementation(async (command) => {
        if (command instanceof PutObjectCommand) {
          throw new Error("S3 is down")
        }
        return {}
      })
      const { pool, acquire } = createFakePool({ maxConsecutiveInfraFailures: 1 })
      const saved: TestResult[] = []

      // Resolves — a storage failure must not abort the whole build (previously the uncaught
      // screenshot-upload rejection did exactly that).
      const testResult = await processStoryWithRetry(baseInfo(saved, pool))

      // The capture/finalize split (issue #456): S3 persistence happens AFTER the browser
      // session is done, so a storage failure retries the cheap finalize phase once (two
      // screenshot PUT attempts) but never re-captures.
      expect(acquire).toHaveBeenCalledTimes(1)
      const putAttempts = mockSend.mock.calls.filter(
        ([command]) => command instanceof PutObjectCommand,
      )
      expect(putAttempts).toHaveLength(2)
      expect(testResult.changeStatus).toBe("failed")
      expect(testResult.errorKind).toBe("storage")
      expect(saved).toHaveLength(1)
      expect(saved[0]?.changeStatus).toBe("failed")
    })

    it("resets the failure counter and counts the story on success", async () => {
      const { pool, session, release } = createFakePool()
      session.consecutiveInfraFailures = 1 // pre-existing strike from an earlier story
      const saved: TestResult[] = []

      await processStoryWithRetry(baseInfo(saved, pool))

      expect(session.consecutiveInfraFailures).toBe(0)
      expect(session.storiesRendered).toBe(1)
      expect(release).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * The capture/finalize split (issue #456): captureStory (session-holding) followed by
   * finalizeStory (no browser) must compose to the same TestResult the one-shot renderStory
   * produced, for both the new-story and baseline-comparison fixtures.
   */
  describe("captureStory + finalizeStory split (#456)", () => {
    function storyInfo() {
      return {
        story: mockStory,
        screenshotTest: mockScreenshotTest,
        bucket: "test-bucket",
        tmpDir: "/tmp/test",
        projectId: "test-project",
        uploadId: "xyz789",
        port: 9009,
        s3Client: new S3Client({}),
        testResultTable: {
          upsert: mockTestResultSave.mockImplementation(async (data: TestResult) =>
            upsertResult(data),
          ),
        } as unknown as Repository<TestResult>,
        browser: mockBrowser,
      }
    }

    it("captureStory produces the screenshot artifacts and holds no S3/DB side effects", async () => {
      const captured = await captureStory(storyInfo())

      expect(captured.story).toBe(mockStory)
      expect(captured.screenshotPath).toBe(`/tmp/test/${mockStory.id}.png`)
      expect(Buffer.isBuffer(captured.screenshotBuffer)).toBe(true)
      expect(captured.viewport).toEqual({ width: 1200, height: 900, devicePixelRatio: 1 })
      expect(captured.captureDurationMs).toBeGreaterThanOrEqual(0)
      // The capture phase must not upload anything or persist any row.
      expect(mockSend).not.toHaveBeenCalledWith(expect.any(PutObjectCommand))
      expect(mockTestResultSave).not.toHaveBeenCalled()
    })

    it("capture then finalize composes to the same result as renderStory (unchanged baseline)", async () => {
      ;(PNG as unknown as { setTestMode(mode: string): void }).setTestMode("unchanged")
      const baseTestResult = new TestResult()
      Object.assign(baseTestResult, {
        id: 789,
        storyId: "test-story",
        screenshotTest: { id: 456, uploadId: "xyz789" },
        changeStatus: "new",
      })
      const info = { ...storyInfo(), baseTestResult }

      const captured = await captureStory(info)
      const testResult = await finalizeStory(info, captured)

      // Same fields renderStory produced for this fixture before the split.
      expect(testResult.changeStatus).toBe("unchanged")
      expect(testResult.diffRatio).toBeLessThan(0.001)
      expect(testResult.name).toBe("components/TestStory/My Component")
      expect(testResult.storyId).toBe(mockStory.id)
      expect(testResult.newImageUrl).toBe(screenshotKey("test-project", "xyz789", mockStory.id))
      expect(mockTestResultSave).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * Issue #456 env knobs are read through the intEnv idiom in environment.ts; verify overrides
   * are honored (and invalid/low values clamp) via a fresh module-registry import.
   */
  describe("throughput env overrides (#456)", () => {
    it("honors explicit overrides for the new env vars", async () => {
      vi.stubEnv("WORKER_FINALIZE_CONCURRENCY", "8")
      vi.stubEnv("WORKER_FINALIZE_QUEUE_LIMIT", "32")
      vi.stubEnv("WORKER_STABILIZE_INTERVAL_MS", "125")
      vi.stubEnv("WORKER_POST_LOAD_DELAY_MS", "0")
      vi.resetModules()
      try {
        const env = await import("./environment")
        expect(env.WORKER_FINALIZE_CONCURRENCY).toBe(8)
        expect(env.WORKER_FINALIZE_QUEUE_LIMIT).toBe(32)
        expect(env.WORKER_STABILIZE_INTERVAL_MS).toBe(125)
        expect(env.WORKER_POST_LOAD_DELAY_MS).toBe(0)
      } finally {
        vi.unstubAllEnvs()
        vi.resetModules()
      }
    })

    it("applies defaults and clamps degenerate values", async () => {
      vi.stubEnv("WORKER_FINALIZE_CONCURRENCY", "0") // clamped to 1
      vi.stubEnv("WORKER_FINALIZE_QUEUE_LIMIT", "not-a-number") // default
      vi.stubEnv("WORKER_STABILIZE_INTERVAL_MS", "") // default
      vi.resetModules()
      try {
        const env = await import("./environment")
        expect(env.WORKER_FINALIZE_CONCURRENCY).toBe(1)
        expect(env.WORKER_FINALIZE_QUEUE_LIMIT).toBe(16)
        expect(env.WORKER_STABILIZE_INTERVAL_MS).toBe(250)
        expect(env.WORKER_POST_LOAD_DELAY_MS).toBe(250)
      } finally {
        vi.unstubAllEnvs()
        vi.resetModules()
      }
    })
  })
})
