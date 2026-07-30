import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Cross-worker sharding groundwork (issue #456, Phase B): schema needed before one build can be
 * split into chunk tasks processed by multiple worker replicas.
 *
 * - `screenshot_tests.expected_story_count` — total number of stories the build is expected to
 *   produce results for, written once the storybook's stories are enumerated. Lets cross-shard
 *   build completion be judged by "count of distinct story results == expected". Nullable:
 *   nothing writes it yet (the chunk-task sharding PR will), and pre-sharding builds never set
 *   it.
 * - `IDX_test_results_test_story` — UNIQUE on ("screenshot_test_id", "story_id"): exactly one
 *   result row per story per build, so shard/story retries can UPSERT idempotently instead of
 *   inserting duplicate rows. Before creating the index, a data-repair pre-pass deletes any
 *   existing duplicate results, keeping the newest (max id) row per (build, story) — the same
 *   row the API's ROW_NUMBER() read-side de-duplication picks today. `down()` drops the index
 *   but does NOT resurrect the deleted duplicates; they were shadowed rows the API never served.
 *
 * Names/columns match the entity decorators (shared/src/entity/ScreenshotTest.ts,
 * shared/src/entity/TestResult.ts) so `synchronize: true` (tests) and migrations produce
 * identical schemas.
 *
 * `IF NOT EXISTS` / `IF EXISTS` keep the statements idempotent.
 */
export class AddShardingSupport1755000000000 implements MigrationInterface {
  name = "AddShardingSupport1755000000000"

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "screenshot_tests" ADD COLUMN IF NOT EXISTS "expected_story_count" integer`,
    )
    // Data repair: delete duplicate per-story results, keeping the max-id survivor (the row the
    // read-side ROW_NUMBER() de-duplication already serves). Must run before the unique index.
    await queryRunner.query(
      `DELETE FROM test_results a
        USING test_results b
        WHERE a.screenshot_test_id = b.screenshot_test_id
          AND a.story_id = b.story_id
          AND a.id < b.id`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_test_results_test_story"
         ON "test_results" ("screenshot_test_id", "story_id")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_test_results_test_story"`)
    await queryRunner.query(
      `ALTER TABLE "screenshot_tests" DROP COLUMN IF EXISTS "expected_story_count"`,
    )
  }
}
