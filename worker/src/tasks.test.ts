/**
 * Task-queue claim + lock lifecycle (issue #456 follow-up).
 *
 * - claimNextTask: runs against a REAL Postgres scratch database (its own
 *   `vizdiff_worker_tasks_test`, separate from shard.test.ts's scratch database because vitest
 *   runs test files in parallel), because the point of the expiry predicate is its SQL
 *   semantics: a lock older than WORKER_TASK_LOCK_TIMEOUT_MINUTES must be claimable by another
 *   worker id, and a fresh lock must not be. The environment mock pins the timeout to 2 minutes
 *   (not the built-in default), proving the env override reaches the claim SQL.
 * - startTaskLockHeartbeat: fake timers + a mocked pool client, asserting locked_at refreshes
 *   while a task is active, stops after release, and survives transient refresh failures.
 * - normalizeTaskDataId: pure tests for the jsonb id normalization (the api's numeric
 *   Project.id vs the worker's string ids).
 */

import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { DatabasePool } from "./database"
import {
  POSTGRES_HOST,
  POSTGRES_PASS,
  POSTGRES_PORT,
  POSTGRES_USER,
  POSTGRES_DATABASE,
} from "./environment"
import { log } from "./log"
import {
  TASK_LOCK_HEARTBEAT_INTERVAL_MS,
  claimNextTask,
  normalizeTaskDataId,
  startTaskLockHeartbeat,
} from "./tasks"

// Pin the lock timeout to 2 minutes — deliberately NOT the built-in default (10) — so the claim
// tests prove the env-configured value (not a hardcoded interval) drives the expiry predicate.
vi.mock("./environment", async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, WORKER_TASK_LOCK_TIMEOUT_MINUTES: 2 }
})

// Stable worker id so claim/heartbeat assertions are deterministic across hosts.
vi.mock("./identity", () => ({ WORKER_ID: "worker-under-test" }))

vi.mock("./database", () => ({
  Database: vi.fn().mockImplementation(async () => {
    throw new Error("Database() must not be called by these tests")
  }),
  DatabasePool: vi.fn().mockImplementation(async () => {
    throw new Error("DatabasePool not initialized yet (beforeAll pending)")
  }),
  closeDatabasePool: vi.fn().mockResolvedValue(undefined),
}))

const SCRATCH_DATABASE = "vizdiff_worker_tasks_test"

let testPool: pg.Pool | undefined

/** Point the mocked DatabasePool back at the real scratch database. */
function usePoolFromScratchDb(): void {
  vi.mocked(DatabasePool).mockImplementation(async () => {
    if (!testPool) {
      throw new Error("test pool closed")
    }
    return await testPool.connect()
  })
}

beforeAll(async () => {
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

  // Minimal mirror of task_queue with the columns the claim/heartbeat SQL touches.
  await testPool.query(`DROP TABLE IF EXISTS task_queue`)
  await testPool.query(`
    CREATE TABLE task_queue (
      id serial PRIMARY KEY,
      screenshot_test_id integer,
      task_type text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      locked_at timestamptz,
      locked_by text,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)

  usePoolFromScratchDb()
}, 30_000)

afterAll(async () => {
  await testPool?.end()
  testPool = undefined
})

beforeEach(async () => {
  await testPool?.query(`TRUNCATE task_queue RESTART IDENTITY`)
})

/** Insert a queue row, optionally already locked `lockedMinutesAgo` minutes ago. */
async function insertTask(opts: {
  taskType?: string
  lockedBy?: string
  lockedMinutesAgo?: number
  attempts?: number
}): Promise<number> {
  const { taskType = "render_story_chunk", lockedBy, lockedMinutesAgo, attempts = 1 } = opts
  const res = await testPool!.query(
    `INSERT INTO task_queue (screenshot_test_id, task_type, data, locked_at, locked_by, attempts)
     VALUES (1, $1, '{}'::jsonb,
             CASE WHEN $2::int IS NULL THEN NULL
                  ELSE NOW() - ($2::int * INTERVAL '1 minute') END,
             $3, $4)
     RETURNING id`,
    [taskType, lockedMinutesAgo ?? null, lockedBy ?? null, attempts],
  )
  return (res.rows[0] as { id: number }).id
}

async function getTaskRow(id: number): Promise<{ locked_by: string | null; attempts: number }> {
  const res = await testPool!.query(`SELECT locked_by, attempts FROM task_queue WHERE id = $1`, [
    id,
  ])
  return res.rows[0] as { locked_by: string | null; attempts: number }
}

describe("claimNextTask lock expiry (WORKER_TASK_LOCK_TIMEOUT_MINUTES)", () => {
  it("claims an unlocked task and records this worker's lock", async () => {
    const id = await insertTask({ attempts: 0 })

    const task = await claimNextTask()

    expect(task).toMatchObject({ id, task_type: "render_story_chunk", attempts: 1 })
    const row = await getTaskRow(id)
    expect(row.locked_by).toBe("worker-under-test")
    expect(row.attempts).toBe(1)
  })

  it("does not claim a task whose lock is still fresh", async () => {
    await insertTask({ lockedBy: "sibling-worker", lockedMinutesAgo: 1 })

    await expect(claimNextTask()).resolves.toBeUndefined()
  })

  it("reclaims a SIGKILL'd worker's expired-lock chunk task under the env-configured timeout", async () => {
    // Locked 3 minutes ago by an owner that died without releasing: expired under the mocked
    // 2-minute WORKER_TASK_LOCK_TIMEOUT_MINUTES (it would still be fresh under the pre-fix
    // hardcoded 60 minutes, or the built-in default 10), so a surviving worker claims it.
    const id = await insertTask({ lockedBy: "dead-worker", lockedMinutesAgo: 3 })

    const task = await claimNextTask()

    expect(task).toMatchObject({ id, attempts: 2 })
    const row = await getTaskRow(id)
    expect(row.locked_by).toBe("worker-under-test")
    expect(row.attempts).toBe(2)
  })
})

describe("startTaskLockHeartbeat", () => {
  const mockQuery = vi.fn()
  const mockRelease = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 })
    mockRelease.mockReset()
    vi.mocked(DatabasePool).mockImplementation(
      async () =>
        ({ query: mockQuery, release: mockRelease }) as unknown as Awaited<
          ReturnType<typeof DatabasePool>
        >,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    usePoolFromScratchDb()
  })

  it("refreshes locked_at while the task is active and stops after release", async () => {
    const stop = startTaskLockHeartbeat(77)
    expect(mockQuery).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(TASK_LOCK_HEARTBEAT_INTERVAL_MS)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("UPDATE task_queue SET locked_at = NOW()")
    // Guarded on ownership so a heartbeat can never re-lock a released/reclaimed/deleted row.
    expect(sql).toContain("locked_by = $2")
    expect(params).toEqual([77, "worker-under-test"])

    await vi.advanceTimersByTimeAsync(TASK_LOCK_HEARTBEAT_INTERVAL_MS)
    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(5 * TASK_LOCK_HEARTBEAT_INTERVAL_MS)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it("keeps ticking after a transient refresh failure", async () => {
    const originalWarn = log.warn
    log.warn = vi.fn()
    try {
      mockQuery.mockRejectedValueOnce(new Error("db blip"))
      const stop = startTaskLockHeartbeat(78)

      await vi.advanceTimersByTimeAsync(TASK_LOCK_HEARTBEAT_INTERVAL_MS)
      expect(mockQuery).toHaveBeenCalledTimes(1)

      // One missed beat is harmless (expiry needs WORKER_TASK_LOCK_TIMEOUT_MINUTES of
      // silence); the next tick must retry.
      await vi.advanceTimersByTimeAsync(TASK_LOCK_HEARTBEAT_INTERVAL_MS)
      expect(mockQuery).toHaveBeenCalledTimes(2)

      stop()
    } finally {
      log.warn = originalWarn
    }
  })
})

describe("normalizeTaskDataId", () => {
  it("passes through non-empty strings", () => {
    expect(normalizeTaskDataId("abc-123")).toBe("abc-123")
  })

  it("normalizes the api's numeric Project.id to a string", () => {
    expect(normalizeTaskDataId(42)).toBe("42")
  })

  it("rejects null, undefined, empty strings, and non-finite numbers", () => {
    expect(normalizeTaskDataId(null)).toBeUndefined()
    expect(normalizeTaskDataId(undefined)).toBeUndefined()
    expect(normalizeTaskDataId("")).toBeUndefined()
    expect(normalizeTaskDataId(NaN)).toBeUndefined()
    expect(normalizeTaskDataId(Infinity)).toBeUndefined()
    expect(normalizeTaskDataId({ id: 1 })).toBeUndefined()
  })
})
