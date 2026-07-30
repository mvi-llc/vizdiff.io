import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Database } from "./database"
import { AddShardingSupport1755000000000 } from "./migrations/1755000000000-AddShardingSupport"

/**
 * Verifies the cross-worker sharding groundwork migration (issue #456, Phase B). The
 * synchronized test schema already has the `expected_story_count` column and the unique
 * (screenshot_test_id, story_id) index, so we first roll the tables back to the pre-migration
 * shape, seed duplicate per-story results (possible pre-migration), then run the migration and
 * assert the new shape — including that the data-repair pre-pass kept only the max-id survivor
 * per (build, story) and that the unique index rejects new duplicates.
 */
describe("AddShardingSupport migration", () => {
  beforeAll(async () => {
    await Database()
  })

  afterAll(async () => {
    const db = await Database()
    if (db.isInitialized) {
      await db.destroy()
    }
  })

  async function indexDef(name: string): Promise<string | undefined> {
    const db = await Database()
    const rows: Array<{ indexdef: string }> = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`,
      [name],
    )
    return rows[0]?.indexdef
  }

  async function columnInfo(
    table: string,
    column: string,
  ): Promise<{ data_type: string; is_nullable: string } | undefined> {
    const db = await Database()
    const rows: Array<{ data_type: string; is_nullable: string }> = await db.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column],
    )
    return rows[0]
  }

  it("adds expected_story_count, repairs duplicate results, and enforces the unique story index", async () => {
    const db = await Database()
    const queryRunner = db.createQueryRunner()
    try {
      // The synchronized (entity-decorator) shape of the unique index, captured so we can assert
      // the migration recreates it identically (synchronize parity).
      const synchronizedIndexDef = await indexDef("IDX_test_results_test_story")
      expect(synchronizedIndexDef).toBeDefined()

      // Roll back to the pre-migration schema shape.
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_test_results_test_story"`)
      await queryRunner.query(
        `ALTER TABLE "screenshot_tests" DROP COLUMN IF EXISTS "expected_story_count"`,
      )
      expect(await columnInfo("screenshot_tests", "expected_story_count")).toBeUndefined()
      expect(await indexDef("IDX_test_results_test_story")).toBeUndefined()

      // Seed a pre-migration build whose story has duplicate result rows (possible before the
      // unique index existed: retried stories inserted a fresh row per attempt).
      await queryRunner.query(
        `INSERT INTO "users" ("auth_subject", "auth_provider", "email")
         VALUES ('mig-456', 'dev', 'mig-456@example.com')`,
      )
      await queryRunner.query(
        `INSERT INTO "projects"
           ("name", "token", "vcs_provider", "repo_id", "repo_url", "gitlab_host", "user_id")
         SELECT 'Mig Project 456', 'mig-456-token', 'gitlab', 42456,
                'https://gitlab.example.com/g/p456', 'https://gitlab.example.com', id
           FROM "users" WHERE "auth_subject" = 'mig-456'`,
      )
      await queryRunner.query(
        `INSERT INTO "screenshot_tests"
           ("project_id", "build_number", "commit_sha", "branch", "upload_id", "status")
         SELECT id, 1, 'sha-456', 'main', 'upload-456', 'unapproved'
           FROM "projects" WHERE "token" = 'mig-456-token'`,
      )
      // Three attempts for story-a (duplicates; max id must survive) and one for story-b.
      const seedRows: Array<[storyId: string, imageUrl: string]> = [
        ["story-a", "attempt-1.png"],
        ["story-a", "attempt-2.png"],
        ["story-a", "attempt-3.png"],
        ["story-b", "only.png"],
      ]
      for (const [storyId, imageUrl] of seedRows) {
        await queryRunner.query(
          `INSERT INTO "test_results"
             ("name", "story_id", "new_image_url", "change_status", "screenshot_test_id")
           SELECT 'Story ' || $1, $1, $2, 'new', id
             FROM "screenshot_tests" WHERE "upload_id" = 'upload-456'`,
          [storyId, imageUrl],
        )
      }

      // Run the migration's up() and confirm the new schema shape.
      await new AddShardingSupport1755000000000().up(queryRunner)

      const column = await columnInfo("screenshot_tests", "expected_story_count")
      expect(column?.data_type).toBe("integer")
      expect(column?.is_nullable).toBe("YES")

      // The recreated unique index matches the entity-decorator (synchronize) shape exactly.
      expect(await indexDef("IDX_test_results_test_story")).toBe(synchronizedIndexDef)

      // The data-repair pre-pass kept only the max-id survivor per (build, story).
      const results = (await queryRunner.query(
        `SELECT tr."story_id", tr."new_image_url"
           FROM "test_results" tr
           JOIN "screenshot_tests" st ON st.id = tr.screenshot_test_id
          WHERE st."upload_id" = 'upload-456'
          ORDER BY tr."story_id"`,
      )) as Array<{ story_id: string; new_image_url: string }>
      expect(results).toEqual([
        { story_id: "story-a", new_image_url: "attempt-3.png" },
        { story_id: "story-b", new_image_url: "only.png" },
      ])

      // The unique index rejects a new duplicate (build, story) row.
      await expect(
        queryRunner.query(
          `INSERT INTO "test_results"
             ("name", "story_id", "new_image_url", "change_status", "screenshot_test_id")
           SELECT 'Story story-a', 'story-a', 'dup.png', 'new', id
             FROM "screenshot_tests" WHERE "upload_id" = 'upload-456'`,
        ),
      ).rejects.toThrow(/IDX_test_results_test_story|duplicate key/)

      // Running the migration again is idempotent (and the repair pre-pass is a no-op).
      await new AddShardingSupport1755000000000().up(queryRunner)
      expect(await indexDef("IDX_test_results_test_story")).toBe(synchronizedIndexDef)

      // down() reverses the schema changes (and is itself idempotent-safe via IF EXISTS). The
      // repaired (deleted) duplicates stay gone by design.
      await new AddShardingSupport1755000000000().down(queryRunner)
      expect(await columnInfo("screenshot_tests", "expected_story_count")).toBeUndefined()
      expect(await indexDef("IDX_test_results_test_story")).toBeUndefined()

      // ...and up() restores the tracked shape for subsequent suites that rely on the
      // synchronized schema.
      await new AddShardingSupport1755000000000().up(queryRunner)
      expect(await columnInfo("screenshot_tests", "expected_story_count")).toBeDefined()
      expect(await indexDef("IDX_test_results_test_story")).toBe(synchronizedIndexDef)
    } finally {
      await queryRunner.release()
    }
  })
})
