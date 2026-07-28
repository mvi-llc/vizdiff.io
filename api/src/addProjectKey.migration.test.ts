import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Database } from "./database"
import { AddProjectKey1752000000000 } from "./migrations/1752000000000-AddProjectKey"

/**
 * Verifies the monorepo-support migration (issue #443). The synchronized test schema already has
 * the `key` column and the widened unique index, so we first roll the `projects` table back to the
 * pre-migration shape (no `key` column, unique index on (vcs_provider, repo_id, gitlab_host)),
 * then run the migration and assert the new shape — including that pre-existing rows get the
 * empty-string default key.
 */
describe("AddProjectKey migration", () => {
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

  async function keyColumnExists(): Promise<boolean> {
    const db = await Database()
    const rows = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'key'`,
    )
    return rows.length > 0
  }

  it("adds the key column and re-keys the uniqueness index", async () => {
    const db = await Database()
    const queryRunner = db.createQueryRunner()
    try {
      // Roll back to the pre-migration schema shape.
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_vcs_repo_host_key"`)
      await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "key"`)
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_vcs_repo_host"
           ON "projects" ("vcs_provider", "repo_id", "gitlab_host")`,
      )

      expect(await keyColumnExists()).toBe(false)
      expect(await indexExists("IDX_vcs_repo_host")).toBe(true)

      // Seed a pre-migration project row (no key column yet).
      await queryRunner.query(
        `INSERT INTO "users" ("auth_subject", "auth_provider", "email")
         VALUES ('mig-443', 'dev', 'mig-443@example.com')`,
      )
      await queryRunner.query(
        `INSERT INTO "projects"
           ("name", "token", "vcs_provider", "repo_id", "repo_url", "gitlab_host", "user_id")
         SELECT 'Mig Project', 'mig-443-token', 'gitlab', 42443, 'https://gitlab.example.com/g/p',
                'https://gitlab.example.com', id
           FROM "users" WHERE "auth_subject" = 'mig-443'`,
      )

      // Run the migration's up() and confirm the new schema shape.
      await new AddProjectKey1752000000000().up(queryRunner)

      expect(await keyColumnExists()).toBe(true)
      expect(await indexExists("IDX_vcs_repo_host")).toBe(false)
      expect(await indexExists("IDX_vcs_repo_host_key")).toBe(true)

      // Pre-existing rows get the empty-string default key.
      const rows = (await queryRunner.query(
        `SELECT "key" FROM "projects" WHERE "token" = 'mig-443-token'`,
      )) as Array<{ key: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]?.key).toBe("")

      // A second project for the same repo with a distinct key is now allowed...
      await queryRunner.query(
        `INSERT INTO "projects"
           ("name", "token", "vcs_provider", "repo_id", "repo_url", "gitlab_host", "user_id", "key")
         SELECT 'Mig Project Web', 'mig-443-token-web', 'gitlab', 42443,
                'https://gitlab.example.com/g/p', 'https://gitlab.example.com', id, 'web'
           FROM "users" WHERE "auth_subject" = 'mig-443'`,
      )
      // ...but a duplicate without a key is still rejected.
      await expect(
        queryRunner.query(
          `INSERT INTO "projects"
             ("name", "token", "vcs_provider", "repo_id", "repo_url", "gitlab_host", "user_id")
           SELECT 'Mig Project Dup', 'mig-443-token-dup', 'gitlab', 42443,
                  'https://gitlab.example.com/g/p', 'https://gitlab.example.com', id
             FROM "users" WHERE "auth_subject" = 'mig-443'`,
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint/i)

      // Running the migration again is idempotent.
      await new AddProjectKey1752000000000().up(queryRunner)
      expect(await indexExists("IDX_vcs_repo_host_key")).toBe(true)
    } finally {
      await queryRunner.release()
    }
  })
})
