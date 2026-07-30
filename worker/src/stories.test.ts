import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import type { WriteStream } from "node:fs"
import { PNG } from "pngjs"
import { TestResult, ScreenshotTest, screenshotKey } from "shared"
import { Readable } from "stream"
import type { Repository } from "typeorm"
import { expect, describe, it, vi, beforeEach } from "vitest"

import { processStory } from "./stories"
import { createMockBrowser, defaultMockPageState } from "./testing/mockBrowser"

/**
 * Test suite for the screenshot comparison functionality.
 *
 * The processStory function:
 * 1. Takes a screenshot of a Storybook story
 * 2. Uploads it to S3
 * 3. Downloads the baseline image (if it exists)
 * 4. Compares the images and determines if there are changes
 * 5. Saves the results to the database
 */

// Mock function declarations for all external dependencies
const mockSend = vi.fn()
const mockTestResultSave = vi.fn()

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
 */
vi.mock("pixelmatch", () => {
  return {
    default: (
      img1: Buffer,
      img2: Buffer,
      _output: Buffer,
      width: number,
      height: number,
      _options?: unknown,
    ) => {
      // If both buffers contain the same data, return 0 differences
      if (img1.toString() === img2.toString()) {
        return 0
      }
      // Otherwise return width * height (all pixels different)
      return width * height
    },
  }
})

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

describe("processStory", () => {
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
    const testResult = await processStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => data),
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

    const testResult = await processStory({
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
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => data),
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

    const testResult = await processStory({
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
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => data),
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

    await processStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => data),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    // Should be called 3 times:
    // 1. Initial attempt (fails)
    // 2. Retry attempt (succeeds)
    // 3. Stability check attempt (succeeds)
    expect(mockBrowserSaveScreenshot).toHaveBeenCalledTimes(3)
    expect(mockBrowserPause).toHaveBeenCalledWith(1000) // For retry delay
    expect(mockBrowserPause).toHaveBeenCalledWith(500) // For stability check interval
  })

  /**
   * Failure isolation (issue #152): a story that fails to render must NOT abort the whole build.
   * processStory records a `failed` TestResult and resolves with it instead of throwing.
   */
  it("isolates a render failure: returns a failed TestResult instead of throwing", async () => {
    // Make navigation to the story fail, so captureStableScreenshot throws.
    mockBrowserUrl.mockRejectedValueOnce(new Error("navigation blew up"))

    const saved: TestResult[] = []
    const testResult = await processStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => {
          saved.push(data)
          return data
        }),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    // Resolves (does not throw) with a failed result so the build can continue.
    expect(testResult.changeStatus).toBe("failed")
    expect(testResult.storyId).toBe(mockStory.id)
    // `new_image_url` is NOT NULL; a failed story has no screenshot, stored as empty string.
    expect(testResult.newImageUrl).toBe("")
    // The failed TestResult was persisted.
    expect(saved.some((r) => r.changeStatus === "failed")).toBe(true)
    // No screenshot was uploaded for the failed story.
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
    mockPageState.contentHeight = [800, TALL_CONTENT_HEIGHT]

    await processStory({
      story: mockStory,
      screenshotTest: mockScreenshotTest,
      bucket: "test-bucket",
      tmpDir: "/tmp/test",
      projectId: "test-project",
      uploadId: "123",
      port: 9009,
      s3Client: new S3Client({}),
      testResultTable: {
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => data),
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

    const testResult = await processStory({
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
        save: mockTestResultSave.mockImplementation(async (data: TestResult) => data),
      } as unknown as Repository<TestResult>,
      browser: mockBrowser,
    })

    expect(testResult.changeStatus).toBe("new")
    expect(testResult.diffRatio).toBe(0)
  })
})
