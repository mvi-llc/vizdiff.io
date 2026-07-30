import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Database } from "./database"
import { AddTestResultErrorColumns1753000000000 } from "./migrations/1753000000000-AddTestResultErrorColumns"

/**
 * Verifies the failed-test-result error-classification migration (issue #454). The synchronized
 * test schema already has the `error_kind` / `error_message` columns, so we first roll the
 * `test_results` table back to the pre-migration shape (no error columns), then run the migration
 * and assert both nullable text columns exist, that up() is idempotent, and that down() removes
 * them again.
 */
describe("AddTestResultErrorColumns migration", () => {
  beforeAll(async () => {
    await Database()
  })

  afterAll(async () => {
    const db = await Database()
    if (db.isInitialized) {
      await db.destroy()
    }
  })

  async function getColumn(name: string): Promise<{ is_nullable: string } | undefined> {
    const db = await Database()
    const rows: Array<{ is_nullable: string }> = await db.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'test_results'
          AND column_name = $1`,
      [name],
    )
    return rows[0]
  }

  it("adds nullable error_kind/error_message columns, idempotently, and down() removes them", async () => {
    const db = await Database()
    const queryRunner = db.createQueryRunner()
    try {
      // Roll back to the pre-migration schema shape.
      await queryRunner.query(`ALTER TABLE "test_results" DROP COLUMN IF EXISTS "error_kind"`)
      await queryRunner.query(`ALTER TABLE "test_results" DROP COLUMN IF EXISTS "error_message"`)

      expect(await getColumn("error_kind")).toBeUndefined()
      expect(await getColumn("error_message")).toBeUndefined()

      // Run the migration's up() and confirm both columns exist and are nullable.
      const migration = new AddTestResultErrorColumns1753000000000()
      await migration.up(queryRunner)

      expect(await getColumn("error_kind")).toEqual({ is_nullable: "YES" })
      expect(await getColumn("error_message")).toEqual({ is_nullable: "YES" })

      // Running the migration again is idempotent.
      await migration.up(queryRunner)

      expect(await getColumn("error_kind")).toEqual({ is_nullable: "YES" })
      expect(await getColumn("error_message")).toEqual({ is_nullable: "YES" })

      // down() removes both columns (and is itself re-runnable).
      await migration.down(queryRunner)

      expect(await getColumn("error_kind")).toBeUndefined()
      expect(await getColumn("error_message")).toBeUndefined()

      // Restore the synchronized schema shape for any suites that run after this one.
      await migration.up(queryRunner)
    } finally {
      await queryRunner.release()
    }
  })
})
