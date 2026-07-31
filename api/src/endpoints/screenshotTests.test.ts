import { Project, ScreenshotTest, TestResult, User } from "shared"
import type { ScreenshotTestStatus } from "shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { get as getTest, listActivity } from "./screenshotTests"
import type { ScreenshotTestSummaryResponse, TestResponse } from "../apiTypes"
import { Database } from "../database"

/**
 * Integration test for GET /api/tests/:id and GET /api/activity (issue #476). Running builds
 * upsert one TestResult row per story as chunks finalize, so the frontend derives live counts
 * from the details response. This pins down against the real Postgres schema that:
 * - `get` surfaces `expectedStoryCount` when the worker has written it, and omits the field from
 *   the JSON payload entirely when the column is NULL (pre-enumeration or legacy builds).
 * - `listActivity` returns the deduplicated per-story test count (`stories`) that its SQL already
 *   computes, including 0 for builds with no results yet.
 */
describe("screenshot test endpoints", () => {
  let user: User
  let runningBuildId = 0
  let legacyBuildId = 0
  let countedBuildId = 0

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
      ) => {
        const screenshotTest = manager.create(ScreenshotTest, {
          project,
          buildNumber,
          commitSha: `sha-${buildNumber}`,
          branch: "main",
          uploadId: `upload-${buildNumber}-${Date.now()}-${Math.random()}`,
          status,
          expectedStoryCount,
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

      // In-flight build with the enumeration total written but no results yet.
      runningBuildId = await createBuild(1, "running", 6, [])
      // Finished build that predates expected_story_count: the column stays NULL.
      legacyBuildId = await createBuild(2, "approved", null, [])
      // In-flight build with partial results: 3 distinct stories, "a" retried (upserted in place).
      countedBuildId = await createBuild(3, "running", 6, ["a", "a", "b", "c"])
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
