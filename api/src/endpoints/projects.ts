import { randomBytes } from "crypto"
import { Project, projectKeyPrefix } from "shared"
import type { VCSProvider } from "shared"

import type { ProjectResponse } from "../apiTypes"
import { toSeconds } from "../conversions"
import { Database } from "../database"
import { GITLAB_HOST } from "../environment"
import { getParamInt } from "../http"
import { log } from "../log"
import { deleteObjectsByPrefixes } from "../s3"
import type { RequestHandler } from "../types"

type ProjectWithStats = {
  project_id: number
  project_name: string
  project_vcs_provider: VCSProvider
  project_repo_id: number
  project_repo_url: string
  project_token: string
  project_created_at: Date
  owner_id: number
  lastbuildstamp: Date | null
  buildcount: string
  testcount: string
}

type CreateProjectBody = {
  name: string
  vcsProvider?: VCSProvider
  repoId?: number
  repoUrl?: string
  // Legacy fields (backward compatibility)
  githubRepoId?: number
  githubRepoUrl?: string
}

/**
 * Build the common project-with-stats SELECT. Callers add their own WHERE clause.
 *
 * When `projectId` is provided, the windowed screenshot_tests subquery is constrained to that
 * project. project_id is the PARTITION BY key, so dropping whole partitions cannot change row
 * numbers (same reasoning as the builds/activity queries in screenshotTests.ts).
 */
function baseProjectStatsQuery(db: Awaited<ReturnType<typeof Database>>, projectId?: number) {
  return db
    .getRepository(Project)
    .createQueryBuilder("project")
    .leftJoin(
      (qb) =>
        qb
          .select([
            "st.projectId as pid",
            "MAX(st.createdAt) as screatedAt",
            // Distinct test names in the project's latest build (st.rn = 1 leaves one row per
            // project, so MAX only collapses the GROUP BY). Correlating on that row's st.id makes
            // this an index lookup into test_results per project instead of a
            // ROW_NUMBER() window scan over the entire table.
            "MAX((SELECT COUNT(DISTINCT tr.name) FROM test_results tr WHERE tr.screenshot_test_id = st.id)) as tcount",
            "(SELECT COUNT(DISTINCT st2.build_number) FROM screenshot_tests st2 WHERE st2.project_id = st.projectId AND st2.status IN ('no_changes', 'unapproved', 'approved')) as buildcount",
          ])
          .from((subQuery) => {
            subQuery
              .select([
                "screenshot_tests.id as id",
                "screenshot_tests.project_id as projectId",
                "screenshot_tests.created_at as createdAt",
                "ROW_NUMBER() OVER (PARTITION BY screenshot_tests.project_id ORDER BY screenshot_tests.created_at DESC) as rn",
              ])
              .from("screenshot_tests", "screenshot_tests")
              .where("screenshot_tests.status IN ('no_changes', 'unapproved', 'approved')")
            if (projectId != undefined) {
              subQuery.andWhere("screenshot_tests.project_id = :projectId", { projectId })
            }
            return subQuery.orderBy("screenshot_tests.created_at", "DESC")
          }, "st")
          .where("st.rn = 1")
          .groupBy("st.projectId"),
      "latest_test",
      "latest_test.pid = project.id",
    )
    .select([
      "project.id",
      "project.name",
      "project.vcsProvider",
      "project.repoId",
      "project.repoUrl",
      "project.token",
      "project.createdAt",
      "project.user as owner_id",
      "latest_test.screatedAt as lastbuildstamp",
      "latest_test.buildcount as buildcount",
      "latest_test.tcount as testcount",
    ])
    .innerJoin("project.user", "user")
}

/**
 * Fetches a single project with its associated statistics.
 */
async function getProjectWithStats(
  db: Awaited<ReturnType<typeof Database>>,
  projectId: number,
): Promise<ProjectWithStats | null> {
  const projectsWithStats = await baseProjectStatsQuery(db, projectId)
    .where("project.id = :projectId", { projectId })
    .getRawOne<ProjectWithStats>()

  return projectsWithStats ?? null
}

/**
 * Convert a ProjectWithStats to a ProjectResponse
 */
function convertToProjectResponse(project: ProjectWithStats): ProjectResponse {
  return {
    id: project.project_id,
    name: project.project_name,
    vcsProvider: project.project_vcs_provider,
    repoUrl: project.project_repo_url,
    githubRepoUrl: project.project_repo_url, // Legacy alias
    token: project.project_token,
    ownerId: project.owner_id,
    createdStampSec: toSeconds(project.project_created_at),
    lastBuildStampSec: project.lastbuildstamp ? toSeconds(project.lastbuildstamp) : 0,
    builds: parseInt(project.buildcount) || 0,
    tests: parseInt(project.testcount) || 0,
  }
}

export const create: RequestHandler = async (req, res) => {
  const { user } = res.locals
  const body = req.body as Partial<CreateProjectBody> | undefined

  const name = body?.name
  // Support both new fields and legacy GitHub-specific fields
  const vcsProviderRaw: string = body?.vcsProvider ?? "github"
  const repoId = body?.repoId ?? body?.githubRepoId
  const repoUrl = body?.repoUrl ?? body?.githubRepoUrl

  // Validate vcsProvider at runtime to prevent invalid values from being stored
  if (vcsProviderRaw !== "github" && vcsProviderRaw !== "gitlab") {
    res
      .status(400)
      .json({ error: `Invalid vcsProvider: "${vcsProviderRaw}". Must be "github" or "gitlab"` })
    return
  }
  const vcsProvider: VCSProvider = vcsProviderRaw

  if (!name) {
    res.status(400).json({ error: "Missing name" })
    return
  }
  if (!repoId) {
    res.status(400).json({ error: "Missing repoId (or githubRepoId)" })
    return
  }
  if (!repoUrl) {
    res.status(400).json({ error: "Missing repoUrl (or githubRepoUrl)" })
    return
  }

  const db = await Database()

  const project = new Project()
  project.name = name
  project.vcsProvider = vcsProvider
  project.repoId = repoId
  project.repoUrl = repoUrl
  // Retain the creator for audit purposes (authorization is now any-authenticated-user).
  project.user = user
  project.token = generateProjectToken()
  if (vcsProvider === "gitlab") {
    // Derive the host from the repo URL origin, falling back to the default host.
    project.gitlabHost = originFromUrl(repoUrl) ?? GITLAB_HOST
  }

  const projectTable = db.getRepository(Project)
  await projectTable.save(project)

  const response: ProjectResponse = {
    id: project.id,
    name: project.name,
    vcsProvider: project.vcsProvider,
    repoUrl: project.repoUrl,
    githubRepoUrl: project.repoUrl, // Legacy alias
    token: project.token,
    ownerId: user.id,
    createdStampSec: toSeconds(project.createdAt),
    lastBuildStampSec: 0,
    builds: 0,
    tests: 0,
  }
  res.json(response)
}

export const remove: RequestHandler = async (req, res) => {
  const id = getParamInt("id", req)
  if (!id) {
    res.status(400).json({ error: "Missing id" })
    return
  }

  const db = await Database()
  const projectTable = db.getRepository(Project)
  const project = await projectTable.findOneBy({ id })

  if (!project) {
    res.status(404).json({ error: "Project not found" })
    return
  }

  await projectTable.remove(project)

  // Best-effort S3 cleanup of the project's screenshots (mirrors account deletion, see user.ts).
  // The DB rows are already gone, so an S3 failure must NOT fail the request; it is logged and left
  // for a later manual sweep or retry. Deletion is idempotent, so a retry is always safe.
  deleteObjectsByPrefixes([projectKeyPrefix(id)])
    .then(({ deleted, errors }) => {
      log.info(
        `Deleted screenshots for project ${id}: ${deleted} objects removed, ${errors} errors`,
      )
    })
    .catch((err: unknown) => {
      log.warn(err, `Failed to delete S3 screenshots for project ${id}`)
    })

  res.json({ success: true })
}

export const list: RequestHandler = async (_req, res) => {
  const db = await Database()

  // Any authenticated user can see all projects.
  const projectsWithStats = await baseProjectStatsQuery(db).getRawMany<ProjectWithStats>()

  const responses: ProjectResponse[] = projectsWithStats.map(convertToProjectResponse)

  // Sort alphabetically by name.
  responses.sort((a, b) => a.name.localeCompare(b.name))

  res.json(responses)
}

export const get: RequestHandler = async (req, res) => {
  const id = getParamInt("id", req)
  if (!id) {
    res.status(400).json({ error: "Missing id" })
    return
  }

  const db = await Database()

  const projectWithStats = await getProjectWithStats(db, id)
  if (!projectWithStats) {
    res.status(404).json({ error: "Project not found" })
    return
  }

  res.json(convertToProjectResponse(projectWithStats))
}

export const resetToken: RequestHandler = async (req, res) => {
  const { user } = res.locals
  const id = getParamInt("id", req)
  if (!id) {
    res.status(400).json({ error: "Missing id" })
    return
  }

  const db = await Database()
  const projectTable = db.getRepository(Project)
  const project = await projectTable.findOneBy({ id })
  if (!project) {
    res.status(404).json({ error: "Project not found" })
    return
  }

  project.token = generateProjectToken()
  await projectTable.save(project)

  // Get the updated project with stats
  const projectWithStats = await getProjectWithStats(db, id)
  if (!projectWithStats) {
    // Failed to fetch the project with stats immediately after writing it. Should never happen
    log.error(
      { userId: user.id, projectId: project.id },
      "Failed to fetch project with stats after saving",
    )
    res.status(500).json({ error: "Token reset failed" })
    return
  }

  res.json(convertToProjectResponse(projectWithStats))
}

/** Generate a random 16-character hex string to use as a project token. */
function generateProjectToken(): string {
  return randomBytes(8).toString("hex") // 8 bytes = 16 hex chars
}

/** Return the origin (scheme://host[:port]) of a URL, or undefined if it cannot be parsed. */
function originFromUrl(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
