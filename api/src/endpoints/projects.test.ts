import { Project, ScreenshotTest, TestResult, User } from "shared"
import type { ScreenshotTestStatus } from "shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { get as getProject, list as listProjects } from "./projects"
import type { ProjectResponse } from "../apiTypes"
import { toSeconds } from "../conversions"
import { Database } from "../database"

/**
 * Integration test for the project stats queries behind GET /api/projects and
 * GET /api/projects/:id (issue #428). The windowed "latest build" / test-count lookup was
 * restructured to avoid scanning all of test_results, so this pins down the expected stats
 * against the real Postgres schema:
 * - `builds` counts distinct build numbers with a finished status (pending/running excluded).
 * - `tests` counts distinct test names in the latest finished build only (retried uploads of the
 *   same name are deduplicated; older builds and unfinished newer builds are ignored).
 * - `lastBuildStampSec` is the created_at of the latest finished build.
 */
describe("project stats endpoints", () => {
  // Fixed, distinct timestamps so "latest build" ordering is deterministic.
  const build1Time = new Date("2026-01-01T00:00:00Z")
  const build2Time = new Date("2026-01-02T00:00:00Z")
  const build3Time = new Date("2026-01-03T00:00:00Z")

  let alphaId = 0
  let betaId = 0

  beforeAll(async () => {
    const db = await Database()

    await db.transaction(async (manager) => {
      const user = manager.create(User, {
        authSubject: `stats-${Date.now()}-${Math.random()}`,
        authProvider: "dev",
        email: `stats-${Date.now()}-${Math.random()}@example.com`,
      })
      await manager.save(user)

      const alpha = manager.create(Project, {
        user,
        name: "Alpha",
        token: `alpha-token-${Date.now()}-${Math.random()}`,
        vcsProvider: "github",
        repoId: Math.floor(Math.random() * 1_000_000_000),
        repoUrl: "https://github.com/stats/alpha",
      })
      await manager.save(alpha)
      alphaId = alpha.id

      // A project with no builds at all: stats must be all zeroes.
      const beta = manager.create(Project, {
        user,
        name: "Beta",
        token: `beta-token-${Date.now()}-${Math.random()}`,
        vcsProvider: "github",
        repoId: Math.floor(Math.random() * 1_000_000_000),
        repoUrl: "https://github.com/stats/beta",
      })
      await manager.save(beta)
      betaId = beta.id

      const createBuild = async (
        buildNumber: number,
        status: ScreenshotTestStatus,
        createdAt: Date,
        testNames: string[],
      ) => {
        const screenshotTest = manager.create(ScreenshotTest, {
          project: alpha,
          buildNumber,
          commitSha: `sha-${buildNumber}`,
          branch: "main",
          uploadId: `upload-${buildNumber}-${Date.now()}-${Math.random()}`,
          status,
        })
        await manager.save(screenshotTest)
        // CreateDateColumn is set by the ORM on insert; pin it explicitly for ordering.
        await manager.query("UPDATE screenshot_tests SET created_at = $1 WHERE id = $2", [
          createdAt,
          screenshotTest.id,
        ])
        for (const name of testNames) {
          const testResult = manager.create(TestResult, {
            name,
            screenshotTest,
            storyId: name,
            newImageUrl: `https://example.com/${name}.png`,
            changeStatus: "unchanged",
          })
          await manager.save(testResult)
        }
      }

      // Older finished build: 3 distinct names, "c" uploaded twice (retry).
      await createBuild(1, "approved", build1Time, ["a", "b", "c", "c"])
      // Latest finished build: 2 distinct names, "a" uploaded twice (retry).
      await createBuild(2, "unapproved", build2Time, ["a", "a", "b"])
      // Newer but unfinished build: must not count toward builds, tests, or last build time.
      await createBuild(3, "pending", build3Time, ["w", "x", "y", "z"])
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
      locals: {},
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

  function expectAlphaStats(project: ProjectResponse) {
    expect(project.name).toBe("Alpha")
    expect(project.builds).toBe(2)
    expect(project.tests).toBe(2)
    expect(project.lastBuildStampSec).toBe(toSeconds(build2Time))
  }

  function expectBetaStats(project: ProjectResponse) {
    expect(project.name).toBe("Beta")
    expect(project.builds).toBe(0)
    expect(project.tests).toBe(0)
    expect(project.lastBuildStampSec).toBe(0)
  }

  it("GET /api/projects returns per-project stats", async () => {
    const res = createMockRes()
    await listProjects({} as never, res as never)

    expect(res.statusCode).toBe(200)
    const projects = res.body as ProjectResponse[]
    const alpha = projects.find((p) => p.id === alphaId)
    const beta = projects.find((p) => p.id === betaId)
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expectAlphaStats(alpha!)
    expectBetaStats(beta!)
  })

  it("GET /api/projects/:id returns stats for a project with builds", async () => {
    const res = createMockRes()
    await getProject({ params: { id: String(alphaId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    expectAlphaStats(res.body as ProjectResponse)
  })

  it("GET /api/projects/:id returns zeroed stats for a project with no builds", async () => {
    const res = createMockRes()
    await getProject({ params: { id: String(betaId) } } as never, res as never)

    expect(res.statusCode).toBe(200)
    expectBetaStats(res.body as ProjectResponse)
  })

  it("GET /api/projects/:id returns 404 for a missing project", async () => {
    const res = createMockRes()
    await getProject({ params: { id: "999999" } } as never, res as never)

    expect(res.statusCode).toBe(404)
  })
})
