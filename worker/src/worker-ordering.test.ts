/**
 * Task claim ordering and deferral (issues #125, #456).
 *
 * Since the sharding-groundwork claim rework (issue #456) the worker claims the OLDEST eligible
 * task (`ORDER BY id ASC` + SKIP LOCKED in claimNextTask), so when two commits A (older, lower
 * task-queue id) then B (newer, higher id) land on the same branch and B's render task depends
 * on A's baseline, A is naturally claimed and processed before B.
 *
 * The deferral machinery (issue #125) still matters for out-of-order enqueues — a dependency
 * that got a HIGHER queue id than its dependent: the dependent is claimed first, defers with
 * DependencyNotReadyError, and is excluded from selection until its backoff expires so the
 * dependency is the only eligible candidate at the re-poll. The re-poll fires strictly *before*
 * the exclusion window expires (DEFER_REPOLL_MS < DEFER_INTERVAL_MS); without that gap the
 * deferred (lower-id) task would no longer be excluded at the re-poll and ascending-id selection
 * would re-claim it instead of its dependency.
 *
 * This suite drives the *real* `pollForNewTasks` loop (the sibling worker test file stubs it
 * out) against a simulated task queue and asserts the processing order.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import "reflect-metadata"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// --- Simulated task queue --------------------------------------------------

type QueuedTask = { task_type: string; screenshot_test_id: number; data: any }

const queue = new Map<number, QueuedTask>()
const processedOrder: number[] = []
const isBaselineBuildPending = vi.fn(async (_screenshotTestId: number) => false)
// Screenshot-test ids whose ingest should fail (to exercise the retry/backoff/give-up paths).
const failingTestIds = new Set<number>()

// Mock the queue *claim* layer (imported by worker.ts from ./tasks). `claimNextTask` returns the
// OLDEST (lowest id) task NOT in the caller's exclude list — mirroring production
// `ORDER BY id ASC` + `NOT (id = ANY(...))`. Locking is not modeled: this suite runs a single
// worker whose `currentTaskId`/`claimInFlight` guards already serialize claims.
vi.mock("./tasks", async (importOriginal) => {
  const actual: object = await importOriginal()
  return {
    ...actual,
    claimNextTask: vi.fn(async (excludeIds: readonly number[] = []) => {
      const exclude = new Set(excludeIds)
      const ids = [...queue.keys()].filter((id) => !exclude.has(id)).sort((a, b) => a - b)
      const id = ids[0]
      if (id == undefined) {
        return undefined
      }
      const task = queue.get(id)
      return task ? { id, attempts: 1, ...task } : undefined
    }),
  }
})

// Mock the ingest layer. `isBaselineBuildPending` reports whether a render task's
// baseline is still in flight; `ingestStorybook` records the processing order.
vi.mock("./ingest", () => ({
  isBaselineBuildPending: (id: number) => isBaselineBuildPending(id),
  ingestStorybook: vi.fn(async (_projectId: string, screenshotTestId: number) => {
    if (failingTestIds.has(screenshotTestId)) {
      throw new Error(`Simulated ingest failure for test ${screenshotTestId}`)
    }
    processedOrder.push(screenshotTestId)
  }),
}))

// worker.ts's `deleteTask`/`releaseLock` are *local* functions that run SQL via
// DatabasePool(). Model the queue at that layer so a successfully-processed task
// is actually removed from our simulated queue (DELETE) and `sweepStuckBuilds`'s
// no-task branch is harmless.
vi.mock("./database", () => ({
  Database: vi.fn(async () => ({
    getRepository: vi.fn(() => ({
      createQueryBuilder: vi.fn(() => ({
        where: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        getMany: vi.fn().mockResolvedValue([]),
      })),
      save: vi.fn().mockResolvedValue({}),
      findOneBy: vi.fn().mockResolvedValue(null),
    })),
  })),
  DatabasePool: vi.fn(async () => ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("DELETE FROM task_queue")) {
        queue.delete(params[0] as number)
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  })),
}))

vi.mock("./health", () => ({
  startHealthServer: vi.fn(),
  markTaskStarted: vi.fn(),
  markTaskFinished: vi.fn(),
}))

vi.mock("pg-listen", () => ({
  default: vi.fn().mockImplementation(() => ({
    notifications: { on: vi.fn() },
    events: { on: vi.fn() },
    connect: vi.fn(),
    listenTo: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

// Imported after the mocks above are registered. worker.ts does not start its
// background loop under test (NODE_ENV === "test"), so this just gives us the
// real `pollForNewTasks` with the dependencies above mocked.
// eslint-disable-next-line import/first -- must load after the vi.mock() calls above
import { pollForNewTasks } from "./worker"

// Task-queue ids: A is older (lower id), B is newer (higher id).
const TASK_A_ID = 100
const TASK_B_ID = 200
// Screenshot-test ids, used to identify which task ran via processedOrder.
const TEST_A_ID = 1000
const TEST_B_ID = 2000

// Flush pending promise microtasks AND process.nextTick callbacks (the worker
// chains its next poll after a success via process.nextTick) so the async poll
// body runs to completion. `await Promise.resolve()` alone does NOT drain
// nextTick in this environment, so we explicitly schedule a continuation behind
// the nextTick queue on each iteration.
async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
    await new Promise<void>((resolve) => process.nextTick(resolve))
  }
}

// Drive the self-rescheduling poll loop deterministically. We use *synchronous*
// fake-timer advancement plus manual microtask flushing rather than the async
// timer helpers: under the default forks pool those helpers cannot fake
// process.nextTick (which the worker uses to chain polls after a success), and
// pumping real nextTick through them blows the heap.
async function pump(done: () => boolean, stepMs: number, maxSteps = 50): Promise<void> {
  await flushMicrotasks()
  for (let i = 0; i < maxSteps && !done(); i++) {
    vi.advanceTimersByTime(stepMs)
    await flushMicrotasks()
  }
}

describe("dependent task ordering — worker processes A before B (#125, #456)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    queue.clear()
    processedOrder.length = 0
    failingTestIds.clear()
    isBaselineBuildPending.mockReset()
    isBaselineBuildPending.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("claims the older dependency A before the newer dependent B (oldest-first)", async () => {
    // Both queued: A (older render of base_commit_sha, still pending) and B
    // (newer, depends on A). Oldest-first claiming picks A directly — no
    // deferral round-trip is needed for the common in-order enqueue.
    queue.set(TASK_A_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: TEST_A_ID,
      data: { projectId: "p", uploadId: "upload-a" },
    })
    queue.set(TASK_B_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: TEST_B_ID,
      data: { projectId: "p", uploadId: "upload-b" },
    })

    // B's baseline (A) is in flight until A has been processed and removed from
    // the queue. A itself has no pending baseline.
    isBaselineBuildPending.mockImplementation(async (screenshotTestId: number) => {
      if (screenshotTestId === TEST_B_ID) {
        return queue.has(TASK_A_ID)
      }
      return false
    })

    pollForNewTasks()
    await pump(() => processedOrder.includes(TEST_A_ID) && processedOrder.includes(TEST_B_ID), 1000)

    // The very first task the worker ran is A (the oldest), then B — and by the
    // time B ran, A was gone from the queue, so B's baseline was populated (its
    // baseline check returned false and no deferral round-trip happened).
    expect(processedOrder).toEqual([TEST_A_ID, TEST_B_ID])
    expect(queue.has(TASK_A_ID)).toBe(false)
    expect(queue.has(TASK_B_ID)).toBe(false)
  })

  it("defers an out-of-order dependent (lower id) so its dependency (higher id) runs first", async () => {
    // Out-of-order enqueue: the dependent got the LOWER queue id and its baseline
    // dependency the HIGHER one, so ascending-id selection claims the dependent
    // first. It must defer (DependencyNotReadyError), stay excluded through the
    // re-poll (DEFER_REPOLL_MS < DEFER_INTERVAL_MS), and let the dependency run.
    const DEPENDENT_TASK_ID = 100
    const DEPENDENT_TEST_ID = 1000
    const DEPENDENCY_TASK_ID = 200
    const DEPENDENCY_TEST_ID = 2000

    queue.set(DEPENDENT_TASK_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: DEPENDENT_TEST_ID,
      data: { projectId: "p", uploadId: "upload-dependent" },
    })
    queue.set(DEPENDENCY_TASK_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: DEPENDENCY_TEST_ID,
      data: { projectId: "p", uploadId: "upload-dependency" },
    })

    // The dependent's baseline is in flight until the dependency task is done.
    isBaselineBuildPending.mockImplementation(async (screenshotTestId: number) => {
      if (screenshotTestId === DEPENDENT_TEST_ID) {
        return queue.has(DEPENDENCY_TASK_ID)
      }
      return false
    })

    pollForNewTasks()
    // Advance in 1s steps so we cross the deferral re-poll (2s) and the
    // exclusion-window expiry (5s) boundaries in order.
    await pump(
      () =>
        processedOrder.includes(DEPENDENT_TEST_ID) && processedOrder.includes(DEPENDENCY_TEST_ID),
      1000,
    )

    // The dependency ran first even though its queue id is higher...
    expect(processedOrder).toEqual([DEPENDENCY_TEST_ID, DEPENDENT_TEST_ID])
    // ...and both tasks were completed and removed from the queue.
    expect(queue.has(DEPENDENT_TASK_ID)).toBe(false)
    expect(queue.has(DEPENDENCY_TASK_ID)).toBe(false)
  })

  it("falls back to processing B after MAX_DEFER_COUNT if its baseline never finishes (livelock guard)", async () => {
    // Only B is queued and its baseline is reported pending forever. The worker
    // must still make forward progress and eventually process B.
    queue.set(TASK_B_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: TEST_B_ID,
      data: { projectId: "p", uploadId: "upload-b" },
    })
    isBaselineBuildPending.mockResolvedValue(true)

    pollForNewTasks()
    // MAX_DEFER_COUNT is 60. With B as the only task, each deferral cycle spans
    // the exclusion window (5s) plus the empty re-poll interval (10s), so advance
    // in 15s steps with a cap comfortably above 60 so the deferrals exhaust and
    // the fallback processes B.
    await pump(() => processedOrder.includes(TEST_B_ID), 15_000, 120)

    expect(processedOrder).toContain(TEST_B_ID)
    expect(queue.has(TASK_B_ID)).toBe(false)
  })
})

describe("failure backoff and give-up", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    queue.clear()
    processedOrder.length = 0
    failingTestIds.clear()
    isBaselineBuildPending.mockReset()
    isBaselineBuildPending.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("does not let a failing oldest task starve newer runnable tasks", async () => {
    // The oldest task (lower id) always fails; the newer task must still run
    // while the failing one sits in its backoff window. Under oldest-first
    // claiming this exclusion is what prevents the failing task from being
    // re-claimed on every poll and starving everything behind it.
    const FAILING_TASK_ID = 300
    const FAILING_TEST_ID = 3000
    const NEW_TASK_ID = 400
    const NEW_TEST_ID = 4000

    queue.set(FAILING_TASK_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: FAILING_TEST_ID,
      data: { projectId: "p", uploadId: "upload-failing" },
    })
    queue.set(NEW_TASK_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: NEW_TEST_ID,
      data: { projectId: "p", uploadId: "upload-new" },
    })
    failingTestIds.add(FAILING_TEST_ID)

    pollForNewTasks()
    // First poll claims the failing (oldest) task; the next poll (10s later) must
    // exclude it (its first backoff window is 30s) and claim the newer task.
    await pump(() => processedOrder.includes(NEW_TEST_ID), 10_000)

    expect(processedOrder).toContain(NEW_TEST_ID)
    expect(queue.has(NEW_TASK_ID)).toBe(false)
    // The failing task is still queued (it is in backoff, not given up yet).
    expect(queue.has(FAILING_TASK_ID)).toBe(true)
  })

  it("deletes a task from the queue after exhausting its retry budget", async () => {
    // A task that fails MAX_RETRY_COUNT+1 times must be removed from the queue,
    // not left in place to restart the retry cycle forever.
    const DOOMED_TASK_ID = 500
    const DOOMED_TEST_ID = 5000

    queue.set(DOOMED_TASK_ID, {
      task_type: "ingest_storybook",
      screenshot_test_id: DOOMED_TEST_ID,
      data: { projectId: "p", uploadId: "upload-doomed" },
    })
    failingTestIds.add(DOOMED_TEST_ID)

    pollForNewTasks()
    // Exponential backoff between attempts sums to ~15.5 minutes before the
    // sixth failure exhausts the budget (MAX_RETRY_COUNT = 5); advance in poll
    // interval (10s) steps with a cap comfortably above that.
    await pump(() => !queue.has(DOOMED_TASK_ID), 10_000, 150)

    expect(queue.has(DOOMED_TASK_ID)).toBe(false)
    expect(processedOrder).not.toContain(DOOMED_TEST_ID)
  })
})
