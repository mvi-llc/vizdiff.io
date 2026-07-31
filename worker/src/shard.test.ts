/**
 * Tests for cross-worker build sharding (issue #456, Phase B).
 *
 * - planChunks: pure partition properties.
 * - reconcileBuildCompletion / recordChunkStoryFailures / giveUpOnChunkTask: run against a REAL
 *   Postgres scratch database (`vizdiff_worker_test`, created on demand next to the api's
 *   `vizdiff_test`), because the whole point of the reconcile is its concurrency semantics —
 *   the `status = 'running'` guard must make exactly one of two concurrent callers win, which
 *   a mocked client cannot prove. Only the two tables the raw SQL touches are created, with the
 *   same column shapes and the unique (screenshot_test_id, story_id) index as the real schema.
 * - Extracted-tarball cache: a cache hit must skip the S3 download entirely (mocked S3 client,
 *   stubbed safeExtract, real filesystem under os.tmpdir()).
 */

import "reflect-metadata"
import type { S3Client } from "@aws-sdk/client-s3"
import { promises as fsPromises } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import pg from "pg"
import type { ScreenshotTest } from "shared"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { DatabasePool } from "./database"
import {
  POSTGRES_HOST,
  POSTGRES_PASS,
  POSTGRES_PORT,
  POSTGRES_USER,
  POSTGRES_DATABASE,
} from "./environment"
import { safeExtract } from "./extract"
import {
  UPLOAD_CACHE_TTL_MS,
  ensureUploadExtracted,
  enqueueRenderChunks,
  giveUpOnChunkTask,
  parseRenderChunkPayload,
  planChunks,
  reconcileBuildCompletion,
  recordChunkStoryFailures,
  sweepStaleUploadCaches,
  uploadCacheDir,
} from "./shard"

// The raw-SQL sharding helpers go through DatabasePool()/Database(); point DatabasePool at the
// scratch database created in beforeAll. Database() (TypeORM) is only reached on VCS-posting
// paths, which these tests never take (no check data), so it stays unimplemented.
vi.mock("./database", () => ({
  Database: vi.fn().mockImplementation(async () => {
    throw new Error("Database() must not be called by these tests")
  }),
  DatabasePool: vi.fn().mockImplementation(async () => {
    throw new Error("DatabasePool not initialized yet (beforeAll pending)")
  }),
  closeDatabasePool: vi.fn().mockResolvedValue(undefined),
}))

// The cache tests exercise the download path against a fake tarball; extraction itself is
// covered in extract.test.ts.
vi.mock("./extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extract")>()
  return { ...actual, safeExtract: vi.fn().mockResolvedValue(undefined) }
})

const SCRATCH_DATABASE = "vizdiff_worker_test"

let testPool: pg.Pool | undefined

beforeAll(async () => {
  // Create the scratch database next to the api's test database if it does not exist yet.
  const adminPool = new pg.Pool({
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    user: POSTGRES_USER,
    password: POSTGRES_PASS,
    database: POSTGRES_DATABASE,
    max: 1,
    connectionTimeoutMillis: 5000,
  })
  try {
    const exists = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      SCRATCH_DATABASE,
    ])
    if ((exists.rowCount ?? 0) === 0) {
      await adminPool.query(`CREATE DATABASE ${SCRATCH_DATABASE}`)
    }
  } finally {
    await adminPool.end()
  }

  testPool = new pg.Pool({
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    user: POSTGRES_USER,
    password: POSTGRES_PASS,
    database: SCRATCH_DATABASE,
    max: 5,
    connectionTimeoutMillis: 5000,
  })

  // Minimal mirrors of the tables the sharding SQL touches, matching the real schema's
  // column shapes and the unique (screenshot_test_id, story_id) index (AddShardingSupport).
  await testPool.query(`DROP TABLE IF EXISTS task_queue`)
  await testPool.query(`DROP TABLE IF EXISTS test_results`)
  await testPool.query(`DROP TABLE IF EXISTS screenshot_tests`)
  await testPool.query(`
    CREATE TABLE screenshot_tests (
      id serial PRIMARY KEY,
      status text NOT NULL,
      expected_story_count integer,
      total_changes integer,
      build_duration_sec double precision,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await testPool.query(`
    CREATE TABLE test_results (
      id serial PRIMARY KEY,
      screenshot_test_id integer NOT NULL,
      story_id text NOT NULL,
      name text NOT NULL,
      new_image_url text NOT NULL,
      change_status text NOT NULL,
      error_kind text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_test_results_test_story UNIQUE (screenshot_test_id, story_id)
    )`)
  await testPool.query(`
    CREATE TABLE task_queue (
      id serial PRIMARY KEY,
      screenshot_test_id integer,
      task_type text NOT NULL,
      data jsonb,
      locked_at timestamptz,
      locked_by text,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)

  vi.mocked(DatabasePool).mockImplementation(async () => {
    if (!testPool) {
      throw new Error("test pool closed")
    }
    return await testPool.connect()
  })
}, 30_000)

afterAll(async () => {
  await testPool?.end()
  testPool = undefined
})

beforeEach(async () => {
  await testPool?.query(`TRUNCATE test_results, screenshot_tests, task_queue RESTART IDENTITY`)
})

async function insertBuild(status: string, expectedStoryCount: number | null): Promise<number> {
  const res = await testPool!.query(
    `INSERT INTO screenshot_tests (status, expected_story_count) VALUES ($1, $2) RETURNING id`,
    [status, expectedStoryCount],
  )
  return (res.rows[0] as { id: number }).id
}

async function insertResult(buildId: number, storyId: string, changeStatus: string): Promise<void> {
  await testPool!.query(
    `INSERT INTO test_results (screenshot_test_id, story_id, name, new_image_url, change_status)
     VALUES ($1, $2, $2, '', $3)`,
    [buildId, storyId, changeStatus],
  )
}

async function getBuild(buildId: number): Promise<{
  status: string
  total_changes: number | null
  build_duration_sec: number | null
}> {
  const res = await testPool!.query(
    `SELECT status, total_changes, build_duration_sec FROM screenshot_tests WHERE id = $1`,
    [buildId],
  )
  return res.rows[0] as {
    status: string
    total_changes: number | null
    build_duration_sec: number | null
  }
}

async function getResults(
  buildId: number,
): Promise<Array<{ story_id: string; change_status: string; error_kind: string | null }>> {
  const res = await testPool!.query(
    `SELECT story_id, change_status, error_kind FROM test_results
     WHERE screenshot_test_id = $1 ORDER BY story_id`,
    [buildId],
  )
  return res.rows as Array<{ story_id: string; change_status: string; error_kind: string | null }>
}

describe("planChunks", () => {
  it("covers every story id exactly once, in order, with only the last chunk short", () => {
    const storyIds = Array.from({ length: 103 }, (_, i) => `story-${i}`)
    const chunks = planChunks(storyIds, 10)

    expect(chunks).toHaveLength(11)
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk).toHaveLength(10)
    }
    expect(chunks[chunks.length - 1]).toHaveLength(3)
    // The concatenation of all chunks is exactly the input (order preserved, no dupes/losses).
    expect(chunks.flat()).toEqual(storyIds)
  })

  it("returns a single chunk when the chunk size covers all stories", () => {
    expect(planChunks(["a", "b", "c"], 50)).toEqual([["a", "b", "c"]])
    expect(planChunks(["a", "b", "c"], 3)).toEqual([["a", "b", "c"]])
  })

  it("clamps a non-positive chunk size to 1", () => {
    expect(planChunks(["a", "b"], 0)).toEqual([["a"], ["b"]])
    expect(planChunks(["a", "b"], -5)).toEqual([["a"], ["b"]])
  })

  it("returns no chunks for no stories", () => {
    expect(planChunks([], 10)).toEqual([])
  })
})

describe("parseRenderChunkPayload", () => {
  const validPayload = {
    projectId: "proj-1",
    uploadId: "upload-1",
    storyIds: ["a", "b"],
    chunkIndex: 0,
    chunkCount: 2,
  }

  it("parses a valid all-string payload", () => {
    expect(parseRenderChunkPayload(validPayload)).toMatchObject(validPayload)
  })

  it("normalizes the api's numeric projectId to a string", () => {
    // The api enqueues `projectId: project.id` where Project.id is a NUMBER
    // (@PrimaryGeneratedColumn), stored unquoted in jsonb. Pre-fix this returned undefined,
    // which deleted every chunk task as non-retryable and stranded the build in "running".
    const parsed = parseRenderChunkPayload({ ...validPayload, projectId: 42 })
    expect(parsed).toMatchObject({ projectId: "42", uploadId: "upload-1" })
  })

  it("normalizes a numeric projectId that round-tripped through Postgres jsonb", async () => {
    const data = JSON.stringify({ ...validPayload, projectId: 42 })
    await testPool!.query(
      `INSERT INTO task_queue (screenshot_test_id, task_type, data)
       VALUES (1, 'render_story_chunk', $1::jsonb)`,
      [data],
    )
    const res = await testPool!.query(`SELECT data FROM task_queue LIMIT 1`)
    const roundTripped = (res.rows[0] as { data: unknown }).data

    // node-postgres parses jsonb back to a JS object with projectId as a number.
    expect((roundTripped as { projectId: unknown }).projectId).toBe(42)
    const parsed = parseRenderChunkPayload(roundTripped)
    expect(parsed).toMatchObject({ projectId: "42", storyIds: ["a", "b"] })
  })

  it("rejects null/missing/empty projectId and uploadId", () => {
    expect(parseRenderChunkPayload({ ...validPayload, projectId: null })).toBeUndefined()
    expect(parseRenderChunkPayload({ ...validPayload, projectId: "" })).toBeUndefined()
    expect(parseRenderChunkPayload({ ...validPayload, uploadId: undefined })).toBeUndefined()
    expect(parseRenderChunkPayload({ ...validPayload, uploadId: "" })).toBeUndefined()
    const { projectId: _dropped, ...withoutProjectId } = validPayload
    expect(parseRenderChunkPayload(withoutProjectId)).toBeUndefined()
  })

  it("rejects malformed storyIds and chunk fields", () => {
    expect(parseRenderChunkPayload({ ...validPayload, storyIds: [] })).toBeUndefined()
    expect(parseRenderChunkPayload({ ...validPayload, storyIds: ["a", 5] })).toBeUndefined()
    expect(parseRenderChunkPayload({ ...validPayload, chunkIndex: -1 })).toBeUndefined()
    expect(parseRenderChunkPayload({ ...validPayload, chunkCount: 0 })).toBeUndefined()
    expect(parseRenderChunkPayload(null)).toBeUndefined()
    expect(parseRenderChunkPayload("nope")).toBeUndefined()
  })
})

describe("enqueueRenderChunks", () => {
  it("inserts one task per chunk with string ids in the jsonb payload even when fed a number", async () => {
    const buildId = await insertBuild("running", 3)
    const screenshotTest = { id: buildId, buildNumber: 1 } as ScreenshotTest

    // Simulate the pre-fix caller: the ingest payload's numeric projectId reaching the enqueue.
    // The enqueued jsonb must still carry string ids.
    await enqueueRenderChunks(screenshotTest, 42, "upload-1", [["a", "b"], ["c"]])

    const res = await testPool!.query(
      `SELECT screenshot_test_id, task_type, data,
              jsonb_typeof(data->'projectId') AS project_id_type,
              jsonb_typeof(data->'uploadId') AS upload_id_type
       FROM task_queue ORDER BY id`,
    )
    expect(res.rowCount).toBe(2)
    const rows = res.rows as Array<{
      screenshot_test_id: number
      task_type: string
      data: Record<string, unknown>
      project_id_type: string
      upload_id_type: string
    }>
    for (const row of rows) {
      expect(row.screenshot_test_id).toBe(buildId)
      expect(row.task_type).toBe("render_story_chunk")
      expect(row.project_id_type).toBe("string")
      expect(row.upload_id_type).toBe("string")
      expect(row.data.projectId).toBe("42")
      expect(row.data.uploadId).toBe("upload-1")
    }
    expect(rows[0]!.data).toMatchObject({ storyIds: ["a", "b"], chunkIndex: 0, chunkCount: 2 })
    expect(rows[1]!.data).toMatchObject({ storyIds: ["c"], chunkIndex: 1, chunkCount: 2 })
  })
})

describe("reconcileBuildCompletion", () => {
  it("returns not_ready while fewer distinct story results exist than expected", async () => {
    const buildId = await insertBuild("running", 3)
    await insertResult(buildId, "a", "unchanged")
    await insertResult(buildId, "b", "unchanged")

    const result = await reconcileBuildCompletion(buildId)

    expect(result).toEqual({ outcome: "not_ready" })
    expect((await getBuild(buildId)).status).toBe("running")
  })

  it("returns not_ready when expected_story_count has not been recorded yet", async () => {
    const buildId = await insertBuild("running", null)
    await insertResult(buildId, "a", "unchanged")

    await expect(reconcileBuildCompletion(buildId)).resolves.toEqual({ outcome: "not_ready" })
  })

  it("completes with no_changes and zero total changes when every story is unchanged", async () => {
    const buildId = await insertBuild("running", 2)
    await insertResult(buildId, "a", "unchanged")
    await insertResult(buildId, "b", "unchanged")

    const result = await reconcileBuildCompletion(buildId)

    expect(result).toEqual({ outcome: "won", status: "no_changes" })
    const build = await getBuild(buildId)
    expect(build.status).toBe("no_changes")
    expect(build.total_changes).toBe(0)
    expect(build.build_duration_sec).not.toBeNull()
  })

  it("counts changed/new/failed stories as changes and completes as unapproved", async () => {
    const buildId = await insertBuild("running", 4)
    await insertResult(buildId, "a", "unchanged")
    await insertResult(buildId, "b", "changed")
    await insertResult(buildId, "c", "new")
    await insertResult(buildId, "d", "failed")

    const result = await reconcileBuildCompletion(buildId)

    expect(result).toEqual({ outcome: "won", status: "unapproved" })
    const build = await getBuild(buildId)
    expect(build.status).toBe("unapproved")
    expect(build.total_changes).toBe(3)
  })

  it("returns already_done for a build that is no longer running", async () => {
    const buildId = await insertBuild("failed", 1)
    await insertResult(buildId, "a", "unchanged")

    await expect(reconcileBuildCompletion(buildId)).resolves.toEqual({ outcome: "already_done" })
    expect((await getBuild(buildId)).status).toBe("failed")
  })

  it("lets exactly one of two concurrent reconciles win", async () => {
    const buildId = await insertBuild("running", 2)
    await insertResult(buildId, "a", "changed")
    await insertResult(buildId, "b", "unchanged")

    // Both callers see a complete, still-running build; the status='running' guard row-locks
    // the build so the loser re-evaluates after the winner commits and observes already_done.
    const [first, second] = await Promise.all([
      reconcileBuildCompletion(buildId),
      reconcileBuildCompletion(buildId),
    ])

    const outcomes = [first.outcome, second.outcome].sort()
    expect(outcomes).toEqual(["already_done", "won"])
    const winner = [first, second].find((r) => r.outcome === "won")
    expect(winner).toEqual({ outcome: "won", status: "unapproved" })
    const build = await getBuild(buildId)
    expect(build.status).toBe("unapproved")
    expect(build.total_changes).toBe(1)
  })
})

describe("recordChunkStoryFailures", () => {
  it("upserts failed rows only for stories without results, preserving earlier successes", async () => {
    const buildId = await insertBuild("running", 3)
    await insertResult(buildId, "a", "changed")

    await recordChunkStoryFailures(buildId, ["a", "b", "c"], "story-error", "vanished")

    const rows = await getResults(buildId)
    expect(rows).toEqual([
      { story_id: "a", change_status: "changed", error_kind: null },
      { story_id: "b", change_status: "failed", error_kind: "story-error" },
      { story_id: "c", change_status: "failed", error_kind: "story-error" },
    ])
  })

  it("is a no-op for an empty story list", async () => {
    const buildId = await insertBuild("running", 1)
    await recordChunkStoryFailures(buildId, [], "unknown", "n/a")
    expect(await getResults(buildId)).toEqual([])
  })
})

describe("giveUpOnChunkTask", () => {
  it("records failed results for the chunk's stories, then reconciles the build to completion", async () => {
    const buildId = await insertBuild("running", 3)
    // A retry of this chunk already rendered one story before failing for good.
    await insertResult(buildId, "a", "changed")

    await giveUpOnChunkTask(buildId, {
      projectId: "p1",
      uploadId: "u1",
      storyIds: ["a", "b", "c"],
      chunkIndex: 0,
      chunkCount: 1,
    })

    const rows = await getResults(buildId)
    expect(rows.map((r) => [r.story_id, r.change_status])).toEqual([
      ["a", "changed"],
      ["b", "failed"],
      ["c", "failed"],
    ])
    expect(rows[1]!.error_kind).toBe("unknown")

    // The give-up completed the build (with partial failures) instead of failing it.
    const build = await getBuild(buildId)
    expect(build.status).toBe("unapproved")
    expect(build.total_changes).toBe(3)
  })

  it("leaves the build running when sibling chunks are still outstanding", async () => {
    const buildId = await insertBuild("running", 5)

    await giveUpOnChunkTask(buildId, {
      projectId: "p1",
      uploadId: "u1",
      storyIds: ["a", "b"],
      chunkIndex: 0,
      chunkCount: 3,
    })

    expect((await getResults(buildId)).map((r) => r.change_status)).toEqual(["failed", "failed"])
    expect((await getBuild(buildId)).status).toBe("running")
  })

  it("tolerates an invalid payload without touching the build", async () => {
    const buildId = await insertBuild("running", 1)
    await giveUpOnChunkTask(buildId, { nope: true })
    expect(await getResults(buildId)).toEqual([])
    expect((await getBuild(buildId)).status).toBe("running")
  })
})

describe("extracted-tarball cache", () => {
  function mockS3Client(): { send: ReturnType<typeof vi.fn> } {
    return {
      send: vi.fn().mockImplementation(async () => ({
        Body: Readable.from([Buffer.from("mock tarball content")]),
      })),
    }
  }

  it("downloads and extracts on a cache miss, then reuses the cache without touching S3", async () => {
    const uploadId = `cache-test-${Date.now()}-${process.pid}`
    const dir = uploadCacheDir(uploadId)
    const s3Client = mockS3Client()
    try {
      const first = await ensureUploadExtracted(
        s3Client as unknown as S3Client,
        "bucket",
        "project-1",
        uploadId,
      )
      expect(first).toBe(dir)
      expect(s3Client.send).toHaveBeenCalledTimes(1)
      expect(safeExtract).toHaveBeenCalledTimes(1)

      // Second chunk of the same upload: cache hit — no download, no extract.
      const second = await ensureUploadExtracted(
        s3Client as unknown as S3Client,
        "bucket",
        "project-1",
        uploadId,
      )
      expect(second).toBe(dir)
      expect(s3Client.send).toHaveBeenCalledTimes(1)
      expect(safeExtract).toHaveBeenCalledTimes(1)
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true })
    }
  })

  it("re-downloads when the previous extract never completed (no marker file)", async () => {
    const uploadId = `cache-test-partial-${Date.now()}-${process.pid}`
    const dir = uploadCacheDir(uploadId)
    const s3Client = mockS3Client()
    try {
      // Simulate a crash mid-extract: the dir exists but the completion marker does not.
      await fsPromises.mkdir(dir, { recursive: true })
      await fsPromises.writeFile(path.join(dir, "partial.js"), "leftover")

      await ensureUploadExtracted(s3Client as unknown as S3Client, "bucket", "project-1", uploadId)

      expect(s3Client.send).toHaveBeenCalledTimes(1)
      // The incomplete dir was rebuilt from scratch.
      await expect(fsPromises.access(path.join(dir, "partial.js"))).rejects.toThrow()
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects an uploadId that is not a plain token", () => {
    expect(() => uploadCacheDir("../escape")).toThrow(/Invalid uploadId/)
    expect(() => uploadCacheDir("a/b")).toThrow(/Invalid uploadId/)
    expect(() => uploadCacheDir(".hidden")).toThrow(/Invalid uploadId/)
  })

  it("sweeps cache dirs older than the TTL and keeps fresh ones", async () => {
    const staleId = `sweep-stale-${Date.now()}-${process.pid}`
    const freshId = `sweep-fresh-${Date.now()}-${process.pid}`
    const staleDir = uploadCacheDir(staleId)
    const freshDir = uploadCacheDir(freshId)
    try {
      await fsPromises.mkdir(staleDir, { recursive: true })
      await fsPromises.mkdir(freshDir, { recursive: true })
      // Age the stale dir past the TTL.
      const old = new Date(Date.now() - UPLOAD_CACHE_TTL_MS - 60_000)
      await fsPromises.utimes(staleDir, old, old)

      await sweepStaleUploadCaches()

      await expect(fsPromises.access(staleDir)).rejects.toThrow()
      await expect(fsPromises.access(freshDir)).resolves.toBeUndefined()
    } finally {
      await fsPromises.rm(staleDir, { recursive: true, force: true })
      await fsPromises.rm(freshDir, { recursive: true, force: true })
    }
  })
})
