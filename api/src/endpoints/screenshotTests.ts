import { Project, ScreenshotTest, TestResult } from "shared"

import type {
  BuildsListResponse,
  ScreenshotTestResponse,
  ScreenshotTestSummaryResponse,
  TestResponse,
} from "../apiTypes"
import { toSeconds } from "../conversions"
import { Database } from "../database"
import { getParamInt, getQueryInt } from "../http"
import { log } from "../log"
import { getAccessibleProjectIds } from "../projectAccess"
import { presignImageUrl, presignImageUrlOrNull } from "../s3"
import type { RequestHandler } from "../types"

/** Default number of builds returned per page by the builds list endpoint. */
const DEFAULT_BUILDS_LIMIT = 100
/** Upper bound on the page size a caller can request. */
const MAX_BUILDS_LIMIT = 100

type ScreenshotTestWithStats = {
  screenshot_test_id: number
  screenshot_test_created_at: Date
  screenshot_test_git_branch: string
  screenshot_test_git_commit: string
  screenshot_test_base_commit_sha: string
  screenshot_test_base_branch: string
  screenshot_test_pr_number?: number
  screenshot_test_build_number: number
  screenshot_test_upload_id: string
  screenshot_test_status: string
  screenshot_test_tag: string
  testcount: string
  changecount: string
}

interface ActivityQueryResult {
  screenshot_test_id: number
  screenshot_test_created_at: Date
  screenshot_test_git_branch: string
  screenshot_test_git_commit: string
  screenshot_test_base_commit_sha: string | null
  screenshot_test_base_branch: string | null
  screenshot_test_pr_number: number | null
  screenshot_test_build_number: number
  screenshot_test_upload_id: string
  screenshot_test_status: string
  screenshot_test_tag: string | null
  project_id: number
  project_name: string
  project_vcs_provider: string
  project_repo_url: string
  testcount: string
}

export const list: RequestHandler = async (req, res) => {
  const { user } = res.locals
  const projectId = getParamInt("projectId", req)
  if (!projectId) {
    res.status(400).json({ error: "Missing projectId" })
    return
  }

  // Pagination: return a page of builds (default 100) plus a flag indicating whether more exist.
  // Clamp the limit to a sane range and the offset to non-negative values.
  const limit = Math.min(
    Math.max(getQueryInt("limit", req) ?? DEFAULT_BUILDS_LIMIT, 1),
    MAX_BUILDS_LIMIT,
  )
  const offset = Math.max(getQueryInt("offset", req) ?? 0, 0)

  const db = await Database()

  // Permissions check
  const projectIds = await getAccessibleProjectIds(db, user.id)
  if (!projectIds.includes(projectId)) {
    log.error(
      { userId: user.id, projectId, projectIds },
      "Project not found in accessible projects",
    )
    res.status(404).json({ error: "Project not found" })
    return
  }

  const projectTable = db.getRepository(Project)
  const project = await projectTable.findOneBy({ id: projectId })

  if (!project) {
    res.status(404).json({ error: "Project not found" })
    return
  }

  const screenshotTestTable = db.getRepository(ScreenshotTest)
  const screenshotTestsWithStats = await screenshotTestTable
    .createQueryBuilder("screenshot_test")
    .innerJoin(
      (qb) =>
        qb
          .select(["MAX(st.id) as latest_id", "st.build_number as build_number"])
          .from(ScreenshotTest, "st")
          .where("st.project_id = :projectId", { projectId })
          .groupBy("st.build_number"),
      "latest_tests",
      "latest_tests.latest_id = screenshot_test.id",
    )
    .leftJoin(
      (qb) =>
        qb
          .select([
            "tr.screenshotTestId as screenshotTestId",
            "COUNT(DISTINCT tr.story_id) as testcount",
            "SUM(CASE WHEN tr.changeStatus = 'changed' OR tr.changeStatus = 'new' THEN 1 ELSE 0 END) as changecount",
          ])
          .from(
            (subQuery) =>
              subQuery
                .select([
                  "tr2.screenshot_test_id as screenshotTestId",
                  "tr2.name as testName",
                  "tr2.story_id as story_id",
                  "tr2.change_status as changeStatus",
                  "ROW_NUMBER() OVER (PARTITION BY tr2.screenshot_test_id, tr2.story_id ORDER BY tr2.id DESC) as rn",
                ])
                .from("test_results", "tr2")
                // Constrain the window scan to this project's tests. screenshot_test_id is part of
                // the PARTITION BY key, so dropping whole partitions cannot change row numbers, and
                // the outer join only ever matches this project's tests anyway.
                .where(
                  "tr2.screenshot_test_id IN " +
                    "(SELECT st2.id FROM screenshot_tests st2 WHERE st2.project_id = :projectId)",
                  { projectId },
                ),
            "tr",
          )
          .where("tr.rn = 1")
          .groupBy("tr.screenshotTestId"),
      "test_counts",
      "test_counts.screenshotTestId = screenshot_test.id",
    )
    .select([
      "screenshot_test.id",
      "screenshot_test.createdAt",
      "screenshot_test.branch as screenshot_test_git_branch",
      "screenshot_test.commitSha as screenshot_test_git_commit",
      "screenshot_test.baseCommitSha as screenshot_test_base_commit_sha",
      "screenshot_test.baseBranch as screenshot_test_base_branch",
      "screenshot_test.prNumber as screenshot_test_pr_number",
      "screenshot_test.buildNumber as screenshot_test_build_number",
      "screenshot_test.uploadId as screenshot_test_upload_id",
      "screenshot_test.status as screenshot_test_status",
      "screenshot_test.tag as screenshot_test_tag",
      "COALESCE(test_counts.testcount, '0') as testcount",
      "COALESCE(test_counts.changecount, '0') as changecount",
    ])
    .where("screenshot_test.project = :projectId", { projectId })
    .orderBy("screenshot_test.createdAt", "DESC")
    // Tiebreaker keeps pagination stable when builds share a createdAt timestamp.
    .addOrderBy("screenshot_test.id", "DESC")
    .offset(offset)
    // Fetch one extra row to detect whether more builds exist beyond this page.
    .limit(limit + 1)
    .getRawMany<ScreenshotTestWithStats>()

  // Trim the sentinel row used to compute hasMore.
  const hasMore = screenshotTestsWithStats.length > limit
  const pageTests = hasMore ? screenshotTestsWithStats.slice(0, limit) : screenshotTestsWithStats

  const builds: ScreenshotTestSummaryResponse[] = pageTests.map((test) => ({
    id: test.screenshot_test_id,
    projectId,
    projectName: project.name,
    vcsProvider: project.vcsProvider,
    repoUrl: project.repoUrl,
    githubRepoUrl: project.repoUrl, // Legacy alias
    buildNumber: test.screenshot_test_build_number,
    commitSha: test.screenshot_test_git_commit,
    branch: test.screenshot_test_git_branch,
    baseCommitSha: test.screenshot_test_base_commit_sha,
    baseBranch: test.screenshot_test_base_branch,
    prNumber: test.screenshot_test_pr_number,
    uploadId: test.screenshot_test_upload_id,
    status: test.screenshot_test_status as ScreenshotTestResponse["status"],
    tag: test.screenshot_test_tag,
    initiatedStampSec: toSeconds(test.screenshot_test_created_at),
    stories: parseInt(test.testcount) || 0,
    changes: parseInt(test.changecount) || 0,
  }))

  const response: BuildsListResponse = { builds, hasMore }
  res.json(response)
}

export const get: RequestHandler = async (req, res) => {
  const { user } = res.locals
  const screenshotTestId = getParamInt("id", req)
  if (!screenshotTestId) {
    res.status(400).json({ error: "Missing id" })
    return
  }

  const db = await Database()

  const screenshotTestTable = db.getRepository(ScreenshotTest)
  const screenshotTest = await screenshotTestTable.findOneBy({ id: screenshotTestId })
  if (!screenshotTest) {
    log.error(`Screenshot test not found: id=${screenshotTestId}`)
    res.status(404).json({ error: "Screenshot test not found" })
    return
  }
  const project = screenshotTest.project

  // Permissions check (mirrors `list`): respond 404 rather than 403 so callers cannot probe
  // which build IDs exist in projects they cannot access.
  const projectIds = await getAccessibleProjectIds(db, user.id)
  if (!projectIds.includes(project.id)) {
    log.error(
      { userId: user.id, projectId: project.id, screenshotTestId },
      "Screenshot test's project not found in accessible projects",
    )
    res.status(404).json({ error: "Screenshot test not found" })
    return
  }

  // Get the most recent test result for each test name
  const testResultTable = db.getRepository(TestResult)
  const testResults = await testResultTable
    .createQueryBuilder("result")
    .innerJoin(
      (qb) =>
        qb
          .select(["tr.story_id as story_id", "MAX(tr.id) as latest_id"])
          .from(TestResult, "tr")
          .where("tr.screenshot_test_id = :screenshotTestId", { screenshotTestId })
          .groupBy("tr.story_id"),
      "latest_results",
      "latest_results.latest_id = result.id",
    )
    .where("result.screenshotTest = :screenshotTestId", { screenshotTestId })
    .getMany()

  // Screenshots live in a private bucket; presign each image for the interactive build viewer.
  const testResultResponses = await Promise.all(
    testResults.map(async (result) => ({
      id: result.id,
      name: result.name,
      changeStatus: result.changeStatus,
      screenshotUrl: await presignImageUrl(result.newImageUrl),
      ancestorScreenshotUrl: (await presignImageUrlOrNull(result.baselineImageUrl)) ?? undefined,
      diffMaskUrl: (await presignImageUrlOrNull(result.diffImageUrl)) ?? undefined,
      diffRatio: result.diffRatio ?? undefined,
      errorKind: result.errorKind ?? undefined,
      errorMessage: result.errorMessage ?? undefined,
      createdStampSec: toSeconds(result.createdAt),
    })),
  )

  // Progress metadata only makes sense while the build is in flight; omit it entirely for
  // terminal builds so stale worker/heartbeat rows never leak into finished-build payloads.
  const isInFlight = screenshotTest.status === "pending" || screenshotTest.status === "running"

  const response: TestResponse = {
    id: screenshotTest.id,
    projectId: project.id,
    projectName: project.name,
    vcsProvider: project.vcsProvider,
    repoUrl: project.repoUrl,
    githubRepoUrl: project.repoUrl, // Legacy alias
    buildNumber: screenshotTest.buildNumber,
    commitSha: screenshotTest.commitSha,
    branch: screenshotTest.branch,
    baseCommitSha: screenshotTest.baseCommitSha ?? undefined,
    baseBranch: screenshotTest.baseBranch ?? undefined,
    prNumber: screenshotTest.prNumber ?? undefined,
    uploadId: screenshotTest.uploadId,
    status: screenshotTest.status,
    tag: screenshotTest.tag ?? undefined,
    initiatedStampSec: toSeconds(screenshotTest.createdAt),
    buildDurationSec: screenshotTest.buildDurationSec ?? undefined,
    expectedStoryCount: screenshotTest.expectedStoryCount ?? undefined,
    // Server-computed age so client clock skew cannot distort the stalled heuristic (issue #477).
    // Falls back to updated_at when no progress heartbeat has been written yet (matching the
    // stuck-build sweeper's COALESCE(last_progress_at, updated_at)).
    lastProgressAgeMs: isInFlight
      ? Date.now() - (screenshotTest.lastProgressAt ?? screenshotTest.updatedAt).getTime()
      : undefined,
    workerId: isInFlight ? (screenshotTest.workerId ?? undefined) : undefined,
    testResults: testResultResponses,
  }

  res.json(response)
}

export const listActivity: RequestHandler = async (_req, res) => {
  const { user } = res.locals
  const db = await Database()
  const screenshotTestTable = db.getRepository(ScreenshotTest)

  // Get all project IDs the user has access to
  const projectIds = await getAccessibleProjectIds(db, user.id)
  if (projectIds.length === 0) {
    res.json([])
    return
  }

  const innerQuery = screenshotTestTable
    .createQueryBuilder("screenshot_test")
    .innerJoin("screenshot_test.project", "project")
    .innerJoin(
      (qb) =>
        qb
          .select([
            "MAX(st.id) as latest_id",
            "st.project_id as project_id",
            "st.build_number as build_number",
          ])
          .from(ScreenshotTest, "st")
          .innerJoin("st.project", "p")
          .where("st.project_id IN (:...projectIds)", { projectIds })
          .groupBy("st.project_id")
          .addGroupBy("st.build_number"),
      "latest_tests",
      "latest_tests.latest_id = screenshot_test.id",
    )
    .leftJoin(
      (qb) =>
        qb
          .select([
            "tr.screenshotTestId as screenshotTestId",
            "COUNT(DISTINCT tr.story_id) as testcount",
          ])
          .from(
            (subQuery) =>
              subQuery
                .select([
                  "tr2.screenshot_test_id as screenshotTestId",
                  "tr2.name as testName",
                  "tr2.story_id as story_id",
                  "ROW_NUMBER() OVER (PARTITION BY tr2.screenshot_test_id, tr2.story_id ORDER BY tr2.id DESC) as rn",
                ])
                .from("test_results", "tr2")
                // Constrain the window scan to the accessible projects' tests. screenshot_test_id
                // is part of the PARTITION BY key, so dropping whole partitions cannot change row
                // numbers, and the outer join only ever matches these projects' tests anyway.
                .where(
                  "tr2.screenshot_test_id IN " +
                    "(SELECT st2.id FROM screenshot_tests st2 WHERE st2.project_id IN (:...projectIds))",
                  { projectIds },
                ),
            "tr",
          )
          .where("tr.rn = 1")
          .groupBy("tr.screenshotTestId"),
      "test_counts",
      "test_counts.screenshotTestId = screenshot_test.id",
    )
    .select([
      "screenshot_test.id as screenshot_test_id",
      "screenshot_test.createdAt as screenshot_test_created_at",
      "screenshot_test.branch as screenshot_test_git_branch",
      "screenshot_test.commitSha as screenshot_test_git_commit",
      "screenshot_test.baseCommitSha as screenshot_test_base_commit_sha",
      "screenshot_test.baseBranch as screenshot_test_base_branch",
      "screenshot_test.prNumber as screenshot_test_pr_number",
      "screenshot_test.buildNumber as screenshot_test_build_number",
      "screenshot_test.uploadId as screenshot_test_upload_id",
      "screenshot_test.status as screenshot_test_status",
      "screenshot_test.tag as screenshot_test_tag",
      "project.id as project_id",
      "project.name as project_name",
      "project.vcs_provider as project_vcs_provider",
      "project.repo_url as project_repo_url",
      "COALESCE(test_counts.testcount, '0') as testcount",
    ])
    .orderBy("screenshot_test.createdAt", "DESC")

  const screenshotTests = (await db
    .createQueryBuilder()
    .select("*")
    .from("(" + innerQuery.getQuery() + ")", "activity")
    .setParameters(innerQuery.getParameters())
    .orderBy("activity.screenshot_test_created_at", "DESC")
    .limit(10)
    .execute()) as ActivityQueryResult[]

  const responses: ScreenshotTestSummaryResponse[] = screenshotTests.map((test) => ({
    id: test.screenshot_test_id,
    projectId: test.project_id,
    projectName: test.project_name,
    vcsProvider: test.project_vcs_provider as ScreenshotTestResponse["vcsProvider"],
    repoUrl: test.project_repo_url,
    githubRepoUrl: test.project_repo_url, // Legacy alias
    buildNumber: test.screenshot_test_build_number,
    commitSha: test.screenshot_test_git_commit,
    branch: test.screenshot_test_git_branch,
    baseCommitSha: test.screenshot_test_base_commit_sha ?? undefined,
    baseBranch: test.screenshot_test_base_branch ?? undefined,
    prNumber: test.screenshot_test_pr_number ?? undefined,
    uploadId: test.screenshot_test_upload_id,
    status: test.screenshot_test_status as ScreenshotTestResponse["status"],
    tag: test.screenshot_test_tag ?? undefined,
    initiatedStampSec: toSeconds(test.screenshot_test_created_at),
    // The SQL already computes the deduped per-story test count; surface it so the activity
    // list can show live counts for running builds (issue #476).
    stories: parseInt(test.testcount) || 0,
  }))

  res.json(responses)
}
