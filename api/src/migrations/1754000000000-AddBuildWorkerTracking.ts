import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Build lifecycle hardening (issues #451, #452): track which worker owns an in-flight build and
 * how often a task has been attempted, so builds orphaned by a fatal worker exit can be failed
 * fast or reclaimed at startup instead of lingering in "running" for hours.
 *
 * - `screenshot_tests.worker_id` — identity of the worker processing the build, set when the
 *   build flips to "running". A restarting worker reclaims running builds that carry its id.
 * - `screenshot_tests.last_progress_at` — reserved for the render progress watchdog (#452).
 *   Nothing writes it yet; the stuck-build sweeper reads COALESCE(last_progress_at, updated_at)
 *   so behavior is unchanged until the watchdog lands.
 * - `task_queue.attempts` — incremented on every claim; bounds how many times a crashing build
 *   is requeued before being failed outright.
 * - `IDX_screenshot_tests_status_worker` — supports the startup reclaim query
 *   (status = 'running' AND worker_id = $me). Name matches the entity `@Index` decorator so
 *   `synchronize: true` (tests) and migrations produce identical schemas.
 *
 * `IF NOT EXISTS` / `IF EXISTS` keep the statements idempotent.
 */
export class AddBuildWorkerTracking1754000000000 implements MigrationInterface {
  name = "AddBuildWorkerTracking1754000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "screenshot_tests" ADD COLUMN IF NOT EXISTS "worker_id" text`,
    )
    await queryRunner.query(
      `ALTER TABLE "screenshot_tests" ADD COLUMN IF NOT EXISTS "last_progress_at" timestamptz`,
    )
    await queryRunner.query(
      `ALTER TABLE "task_queue" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_screenshot_tests_status_worker"
         ON "screenshot_tests" ("status", "worker_id")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_screenshot_tests_status_worker"`)
    await queryRunner.query(`ALTER TABLE "task_queue" DROP COLUMN IF EXISTS "attempts"`)
    await queryRunner.query(
      `ALTER TABLE "screenshot_tests" DROP COLUMN IF EXISTS "last_progress_at"`,
    )
    await queryRunner.query(`ALTER TABLE "screenshot_tests" DROP COLUMN IF EXISTS "worker_id"`)
  }
}
