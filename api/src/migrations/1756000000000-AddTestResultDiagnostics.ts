import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Failure diagnostics for failed test results (issue #475): a failed story used to carry only
 * `error_kind`/`error_message` — one line, nothing to act on. The worker now also captures the
 * browser console tail, the network requests still in flight at failure time, and a best-effort
 * failure-time screenshot, persisted per story so the API/UI can surface them.
 *
 * Adds one nullable jsonb column to `test_results`:
 *
 * - `diagnostics`: a `TestResultDiagnostics` payload (shared/src/entity/types.ts) with
 *   `consoleTail`, `pendingRequests`, and an optional `failureScreenshotKey` (S3 object key of
 *   the failure screenshot, presigned at read time like the other image columns). NULL for
 *   non-failed results and for rows written before this migration.
 *
 * The column matches the entity `@Column` decorator in shared/src/entity/TestResult.ts so
 * `synchronize: true` (tests) and migrations produce identical schemas. `IF NOT EXISTS` /
 * `IF EXISTS` keep the statements idempotent.
 */
export class AddTestResultDiagnostics1756000000000 implements MigrationInterface {
  name = "AddTestResultDiagnostics1756000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "test_results" ADD COLUMN IF NOT EXISTS "diagnostics" jsonb`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "test_results" DROP COLUMN IF EXISTS "diagnostics"`)
  }
}
