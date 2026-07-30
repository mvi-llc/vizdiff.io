import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Database } from "./database"
import { AddBuildWorkerTracking1754000000000 } from "./migrations/1754000000000-AddBuildWorkerTracking"

/**
 * Verifies the build-lifecycle-hardening migration (issues #451/#452). The synchronized test
 * schema already has the `worker_id` / `last_progress_at` / `attempts` columns and the
 * status+worker index, so we first roll the tables back to the pre-migration shape, then run the
 * migration and assert the new shape — including that pre-existing task rows get the
 * `attempts = 0` default.
 */
describe("AddBuildWorkerTracking migration", () => {
  beforeAll(async () => {
    await Database()
  })

  afterAll(async () => {
    const db = await Database()
    if (db.isInitialized) {
      await db.destroy()
    }
  })

  async function indexExists(name: string): Promise<boolean> {
    const db = await Database()
    const rows = await db.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
      [name],
    )
    return rows.length > 0
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    const db = await Database()
    const rows = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column],
    )
    return rows.length > 0
  }

  it("adds the worker tracking columns and status+worker index", async () => {
    const db = await Database()
    const queryRunner = db.createQueryRunner()
    try {
      // Roll back to the pre-migration schema shape.
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_screenshot_tests_status_worker"`)
      await queryRunner.query(`ALTER TABLE "screenshot_tests" DROP COLUMN IF EXISTS "worker_id"`)
      await queryRunner.query(
        `ALTER TABLE "screenshot_tests" DROP COLUMN IF EXISTS "last_progress_at"`,
      )
      await queryRunner.query(`ALTER TABLE "task_queue" DROP COLUMN IF EXISTS "attempts"`)

      expect(await columnExists("screenshot_tests", "worker_id")).toBe(false)
      expect(await columnExists("screenshot_tests", "last_progress_at")).toBe(false)
      expect(await columnExists("task_queue", "attempts")).toBe(false)
      expect(await indexExists("IDX_screenshot_tests_status_worker")).toBe(false)

      // Seed a pre-migration build with a queued task (no attempts column yet).
      await queryRunner.query(
        `INSERT INTO "users" ("auth_subject", "auth_provider", "email")
         VALUES ('mig-451', 'dev', 'mig-451@example.com')`,
      )
      await queryRunner.query(
        `INSERT INTO "projects"
           ("name", "token", "vcs_provider", "repo_id", "repo_url", "gitlab_host", "user_id")
         SELECT 'Mig Project 451', 'mig-451-token', 'gitlab', 42451,
                'https://gitlab.example.com/g/p451', 'https://gitlab.example.com', id
           FROM "users" WHERE "auth_subject" = 'mig-451'`,
      )
      await queryRunner.query(
        `INSERT INTO "screenshot_tests"
           ("project_id", "build_number", "commit_sha", "branch", "upload_id", "status")
         SELECT id, 1, 'sha-451', 'main', 'upload-451', 'running'
           FROM "projects" WHERE "token" = 'mig-451-token'`,
      )
      await queryRunner.query(
        `INSERT INTO "task_queue" ("screenshot_test_id", "task_type", "data")
         SELECT id, 'ingest_storybook', '{}'::jsonb
           FROM "screenshot_tests" WHERE "upload_id" = 'upload-451'`,
      )

      // Run the migration's up() and confirm the new schema shape.
      await new AddBuildWorkerTracking1754000000000().up(queryRunner)

      expect(await columnExists("screenshot_tests", "worker_id")).toBe(true)
      expect(await columnExists("screenshot_tests", "last_progress_at")).toBe(true)
      expect(await columnExists("task_queue", "attempts")).toBe(true)
      expect(await indexExists("IDX_screenshot_tests_status_worker")).toBe(true)

      // Pre-existing task rows get the attempts default of 0; pre-existing builds get NULL
      // worker tracking fields.
      const taskRows = (await queryRunner.query(
        `SELECT "attempts" FROM "task_queue" tq
          JOIN "screenshot_tests" st ON st.id = tq.screenshot_test_id
         WHERE st."upload_id" = 'upload-451'`,
      )) as Array<{ attempts: number }>
      expect(taskRows).toHaveLength(1)
      expect(taskRows[0]?.attempts).toBe(0)

      const buildRows = (await queryRunner.query(
        `SELECT "worker_id", "last_progress_at" FROM "screenshot_tests"
         WHERE "upload_id" = 'upload-451'`,
      )) as Array<{ worker_id: string | null; last_progress_at: Date | null }>
      expect(buildRows).toHaveLength(1)
      expect(buildRows[0]?.worker_id).toBeNull()
      expect(buildRows[0]?.last_progress_at).toBeNull()

      // Running the migration again is idempotent.
      await new AddBuildWorkerTracking1754000000000().up(queryRunner)
      expect(await indexExists("IDX_screenshot_tests_status_worker")).toBe(true)

      // down() reverses the changes (and is itself idempotent-safe via IF EXISTS)...
      await new AddBuildWorkerTracking1754000000000().down(queryRunner)
      expect(await columnExists("screenshot_tests", "worker_id")).toBe(false)
      expect(await columnExists("screenshot_tests", "last_progress_at")).toBe(false)
      expect(await columnExists("task_queue", "attempts")).toBe(false)
      expect(await indexExists("IDX_screenshot_tests_status_worker")).toBe(false)

      // ...and up() restores the tracked shape for subsequent suites that rely on the
      // synchronized schema.
      await new AddBuildWorkerTracking1754000000000().up(queryRunner)
      expect(await columnExists("screenshot_tests", "worker_id")).toBe(true)
      expect(await columnExists("task_queue", "attempts")).toBe(true)
    } finally {
      await queryRunner.release()
    }
  })
})
