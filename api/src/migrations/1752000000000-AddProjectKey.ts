import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Monorepo support (issue #443): allow multiple VizDiff projects per VCS repository.
 *
 * Adds a `projects.key` discriminator column (text, NOT NULL, default '') and re-keys the
 * repo-uniqueness index from `(vcs_provider, repo_id, gitlab_host)` to
 * `(vcs_provider, repo_id, gitlab_host, key)`:
 *
 * - Existing rows get `key = ''`, so every current project keeps its identity and its commit
 *   status context (`vizdiff/visual-tests`) unchanged.
 * - Creating a second project for the same repo now succeeds when it carries a distinct
 *   non-empty key; creating one *without* a key is still rejected by the unique index, preserving
 *   the old accidental-duplicate safety net.
 *
 * Index name matches the entity `@Index` decorator (`IDX_vcs_repo_host_key`) so
 * `synchronize: true` (tests) and migrations produce identical schemas. `IF NOT EXISTS` /
 * `IF EXISTS` keep the statements idempotent.
 */
export class AddProjectKey1752000000000 implements MigrationInterface {
  name = "AddProjectKey1752000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "key" text NOT NULL DEFAULT ''`,
    )
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_vcs_repo_host"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_vcs_repo_host_key"
         ON "projects" ("vcs_provider", "repo_id", "gitlab_host", "key")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_vcs_repo_host_key"`)
    // Note: restoring the narrower unique index fails if multiple projects now share a repo
    // (that is the feature this migration enables); those rows must be removed first.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_vcs_repo_host"
         ON "projects" ("vcs_provider", "repo_id", "gitlab_host")`,
    )
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "key"`)
  }
}
