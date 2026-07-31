import { Project, ScreenshotTest, TestResult, User } from "shared"
import type { ScreenshotTestStatus } from "shared"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { get as getTest, listActivity } from "./screenshotTests"
import type { ScreenshotTestSummaryResponse, TestResponse } from "../apiTypes"
import { Database } from "../database"
import { getAccessibleProjectIds } from "../projectAccess"

// Spy-wrap the access helper so the 404 path of `get`'s permissions check can be exercised: the
// real implementation grants every authenticated user access to every project (self-hosted
// deployment), so an inaccessible project cannot be constructed from data alone.
vi.mock("../projectAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projectAccess")>()
  return { ...actual, getAccessibleProjectIds: vi.fn(actual.getAccessibleProjectIds) }
})

/**
 * Integration test for GET /api/tests/:id and GET /api/activity (issues #476/#477). Running
 * builds upsert one TestResult row per story as chunks finalize, so the frontend derives live
 * counts from the details response. This pins down against the real Postgres schema that:
 * - `get` surfaces `expectedStoryCount` when the worker has written it, and omits the field from
 *   the JSON payload entirely when the column is NULL (pre-enumeration or legacy builds).
 * - `get` surfaces the server-computed `lastProgressAgeMs` (falling back to updated_at when no
 *   heartbeat exists) and `workerId` while the build is in flight, and omits both once terminal.
 * - `get` 404s when the build's project is not in the caller's accessible set.
 * - `listActivity` returns the deduplicated per-story test count (`stories`) that its SQL already
 *   computes, including 0 for builds with no results yet.
 */
describe("screenshot test endpoints", () => {
  let user: User
  let runningBuildId = 0
  let legacyBuildId = 0
  let countedBuildId = 0
  let heartbeatBuildId = 0

  /** last_progress_at written for the heartbeat build, relative to the seeding time. */
  const HEARTBEAT_AGE_MS = 5000

  beforeAll(async () => {
    const db = await Database()

    await db.transaction(async (manager) => {
      user = manager.create(User, {
        authSubject: `tests-${Date.now()}-${Math.random()}`,
        authProvider: "dev",
        email: `tests-${Date.now()}-${Math.random()}@example.com`,
      })
      await manager.save(user)

      const project = manager.create(Project, {
        user,
        name: "Gamma",
        token: `gamma-token-${Date.now()}-${Math.random()}`,
        vcsProvider: "github",
        repoId: Math.floor(Math.random() * 1_000_000_000),
        repoUrl: "https://github.com/tests/gamma",
      })
      await manager.save(project)

      const createBuild = async (
        buildNumber: number,
        status: ScreenshotTestStatus,
        expectedStoryCount: number | null,
        storyIds: string[],
        progress?: { workerId?: string; lastProgressAt?: Date },
      ) => {
        const screenshotTest = manager.create(ScreenshotTest, {
          project,
          buildNumber,
          commitSha: `sha-${buildNumber}`,
          branch: "main",
          uploadId: `upload-${buildNumber}-${Date.now()}-${Math.random()}`,
          status,
          expectedStoryCount,
          workerId: progress?.workerId ?? null,
          lastProgressAt: progress?.lastProgressAt ?? null,
        })
        await manager.save(screenshotTest)
        for (const storyId of storyIds) {
          // Since issue #456 (unique (screenshot_test_id, story_id) index) a retried story
          // upload is an idempotent upsert — seed the same way the worker writes so repeated
          // story IDs exercise the deduplication path.
          await manager.upsert(
            TestResult,
            {
              name: storyId,
              screenshotTest,
              storyId,
              newImageUrl: `https://example.com/${storyId}.png`,
              changeStatus: "unchanged",
            },
            { conflictPaths: ["screenshotTest", "storyId"] },
          )
        }
        return screenshotTest.id
      }

      // In-flight build with the enumeration total written but no results yet. No heartbeat has
      // been written, so lastProgressAgeMs must fall back to updated_at.
      runningBuildId = await createBuild(1, "running", 6, [])
      // Finished build that predates expected_story_count: the column stays NULL. Progress
      // columns are populated to prove the terminal-status gating omits them from the payload.
      legacyBuildId = await createBuild(2, "approved", null, [], {
        workerId: "worker-terminal",
        lastProgressAt: new Date(),
      })
      // In-flight build with partial results: 3 distinct stories, "a" retried (upserted in place).
      countedBuildId = await createBuild(3, "running", 6, ["a", "a", "b", "c"])
      // In-flight build with a worker identity and a ~5s-old progress heartbeat (issue #477).
      // No test results: the get endpoint presigns image URLs for every result, and the test
      // environment has no S3 region configured ("Region is missing" in CI).
      heartbeatBuildId = await createBuild(4, "running", 6, [], {
        workerId: "worker-1",
        lastProgressAt: new Date(Date.now() - HEARTBEAT_AGE_MS),
      })
    })
  })

  afterAll(async () => {
    const db = await Database()
    if (db.isInitialized) {
      await db.destroy()
    }
  })

  function createMockRes() {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      locals: { user },
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(payload: unknown) {
        this.body = payload
      },
    }
    return res
  }

  it("GET /api/tests/:id returns expectedStoryCount when set", async () => {
    const res = createMockRes()
    await getTest({ params: { id: String(runningBuildId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    const response = res.body as TestResponse
    expect(response.id).toBe(runningBuildId)
    expect(response.status).toBe("running")
    expect(response.expectedStoryCount).toBe(6)
    expect(response.testResults).toEqual([])
  })

  it("GET /api/tests/:id omits expectedStoryCount when the column is NULL", async () => {
    const res = createMockRes()
    await getTest({ params: { id: String(legacyBuildId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    const response = res.body as TestResponse
    expect(response.id).toBe(legacyBuildId)
    // Round-trip through JSON to assert the field is omitted from the payload, not just undefined.
    const serialized = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>
    expect(serialized).not.toHaveProperty("expectedStoryCount")
  })

  it("GET /api/tests/:id computes lastProgressAgeMs from last_progress_at and passes workerId", async () => {
    const res = createMockRes()
    await getTest({ params: { id: String(heartbeatBuildId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    const response = res.body as TestResponse
    expect(response.workerId).toBe("worker-1")
    // The heartbeat was written HEARTBEAT_AGE_MS before seeding; the request runs some test
    // overhead later, so assert a tolerant window rather than an exact age.
    expect(response.lastProgressAgeMs).toBeGreaterThanOrEqual(HEARTBEAT_AGE_MS - 1000)
    expect(response.lastProgressAgeMs).toBeLessThan(HEARTBEAT_AGE_MS + 60_000)
  })

  it("GET /api/tests/:id falls back to updated_at when last_progress_at is NULL", async () => {
    const res = createMockRes()
    await getTest({ params: { id: String(runningBuildId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    const response = res.body as TestResponse
    // The build row was updated at seeding time, so the fallback age is small but non-negative.
    expect(response.lastProgressAgeMs).toBeGreaterThanOrEqual(0)
    expect(response.lastProgressAgeMs).toBeLessThan(60_000)
  })

  it("GET /api/tests/:id omits progress fields for terminal builds", async () => {
    const res = createMockRes()
    await getTest({ params: { id: String(legacyBuildId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    // The columns are populated for this build; only the terminal status must gate them out.
    // Round-trip through JSON to assert omission from the payload, not just undefined.
    const serialized = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>
    expect(serialized).not.toHaveProperty("lastProgressAgeMs")
    expect(serialized).not.toHaveProperty("workerId")
  })

  it("GET /api/tests/:id returns 404 when the project is not accessible", async () => {
    vi.mocked(getAccessibleProjectIds).mockResolvedValueOnce([])

    const res = createMockRes()
    await getTest({ params: { id: String(runningBuildId) } } as never, res as never)

    expect(res.statusCode).toBe(404)
    // Same shape as the missing-build response so callers cannot probe for existing IDs.
    expect(res.body).toEqual({ error: "Screenshot test not found" })
  })

  it("GET /api/activity returns deduplicated per-story test counts", async () => {
    const res = createMockRes()
    await listActivity({} as never, res as never)

    expect(res.statusCode).toBe(200)
    const responses = res.body as ScreenshotTestSummaryResponse[]

    const counted = responses.find((test) => test.id === countedBuildId)
    expect(counted).toBeDefined()
    expect(counted!.stories).toBe(3)

    const running = responses.find((test) => test.id === runningBuildId)
    expect(running).toBeDefined()
    expect(running!.stories).toBe(0)
  })
})
