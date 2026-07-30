import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Error classification for failed test results (issue #454): infra failures (dead browser
 * session, command timeouts, storage errors) were recorded as the same permanent `failed`
 * TestResult as genuine story failures, misleading reviewers into treating harness crashes as
 * product regressions.
 *
 * Adds two nullable text columns to `test_results`:
 *
 * - `error_kind`: machine-readable classification (`TestResultErrorKind` in shared) that
 *   distinguishes infra-class errors (`browser-timeout`, `browser-gone`, `screenshot-failed`,
 *   `storage`) from story-class errors (`story-error`, `render-timeout`, ...).
 * - `error_message`: human-readable error detail for display in the build viewer.
 *
 * `changeStatus` deliberately keeps its existing four values — a fifth status would break the
 * throwing status switches and counts across shared/api/frontend — so both columns are simply
 * NULL for non-failed results and for rows written before this migration.
 *
 * Columns match the entity `@Column` decorators in shared/src/entity/TestResult.ts so
 * `synchronize: true` (tests) and migrations produce identical schemas. `IF NOT EXISTS` /
 * `IF EXISTS` keep the statements idempotent.
 */
export class AddTestResultErrorColumns1753000000000 implements MigrationInterface {
  name = "AddTestResultErrorColumns1753000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "test_results" ADD COLUMN IF NOT EXISTS "error_kind" text`)
    await queryRunner.query(
      `ALTER TABLE "test_results" ADD COLUMN IF NOT EXISTS "error_message" text`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "test_results" DROP COLUMN IF EXISTS "error_message"`)
    await queryRunner.query(`ALTER TABLE "test_results" DROP COLUMN IF EXISTS "error_kind"`)
  }
}
