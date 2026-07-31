import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Database } from "./database"
import { AddTestResultDiagnostics1756000000000 } from "./migrations/1756000000000-AddTestResultDiagnostics"

/**
 * Verifies the failed-test-result diagnostics migration (issue #475). The synchronized test
 * schema already has the `diagnostics` column, so we first roll the `test_results` table back to
 * the pre-migration shape (no diagnostics column), then run the migration and assert the nullable
 * jsonb column exists, that up() is idempotent, and that down() removes it again.
 */
describe("AddTestResultDiagnostics migration", () => {
  beforeAll(async () => {
    await Database()
  })

  afterAll(async () => {
    const db = await Database()
    if (db.isInitialized) {
      await db.destroy()
    }
  })

  async function getColumn(
    name: string,
  ): Promise<{ is_nullable: string; data_type: string } | undefined> {
    const db = await Database()
    const rows: Array<{ is_nullable: string; data_type: string }> = await db.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'test_results'
          AND column_name = $1`,
      [name],
    )
    return rows[0]
  }

  it("adds a nullable diagnostics jsonb column, idempotently, and down() removes it", async () => {
    const db = await Database()
    const queryRunner = db.createQueryRunner()
    try {
      // Roll back to the pre-migration schema shape.
      await queryRunner.query(`ALTER TABLE "test_results" DROP COLUMN IF EXISTS "diagnostics"`)

      expect(await getColumn("diagnostics")).toBeUndefined()

      // Run the migration's up() and confirm the column exists, is nullable, and is jsonb.
      const migration = new AddTestResultDiagnostics1756000000000()
      await migration.up(queryRunner)

      expect(await getColumn("diagnostics")).toEqual({ is_nullable: "YES", data_type: "jsonb" })

      // Running the migration again is idempotent.
      await migration.up(queryRunner)

      expect(await getColumn("diagnostics")).toEqual({ is_nullable: "YES", data_type: "jsonb" })

      // down() removes the column (and is itself re-runnable).
      await migration.down(queryRunner)

      expect(await getColumn("diagnostics")).toBeUndefined()

      // Restore the synchronized schema shape for any suites that run after this one.
      await migration.up(queryRunner)
    } finally {
      await queryRunner.release()
    }
  })
})
