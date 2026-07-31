import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm"

import type { ScreenshotTest } from "./ScreenshotTest"
import type { TestResultDiagnostics, TestResultErrorKind, TestResultStatus } from "./types"

@Entity("test_results")
@Index("IDX_test_results_screenshot_test_id", ["screenshotTest.id"])
// One result row per story per build (issue #456, cross-worker sharding groundwork): shard/story
// retries UPSERT on this key instead of inserting duplicate rows. Name and column order must
// match the migration (AddShardingSupport) exactly so `synchronize: true` (tests) and migrations
// produce identical schemas.
@Index("IDX_test_results_test_story", ["screenshotTest.id", "storyId"], { unique: true })
export class TestResult {
  @PrimaryGeneratedColumn()
  id!: number

  @Column({ type: "text", name: "name", nullable: false })
  name!: string

  @ManyToOne("ScreenshotTest", "testResults", {
    onDelete: "CASCADE",
    nullable: false,
    eager: true,
  })
  @JoinColumn({ name: "screenshot_test_id", referencedColumnName: "id" })
  screenshotTest!: ScreenshotTest

  @Column({ type: "text", name: "story_id", nullable: false })
  storyId!: string

  @Column({ type: "jsonb", name: "story", nullable: true })
  story!: object | null

  @Column({ type: "text", name: "baseline_image_url", nullable: true })
  baselineImageUrl!: string | null

  @Column({ type: "text", name: "new_image_url", nullable: false })
  newImageUrl!: string

  @Column({ type: "text", name: "diff_image_url", nullable: true })
  diffImageUrl!: string | null

  // NOTE: `diffRatio` is not following the snake_case naming convention, this is legacy
  @Column({ type: "double precision", name: "diffRatio", nullable: true })
  diffRatio!: number | null

  // Can be "new", "unchanged", "changed", or "failed"
  @Column({ type: "text", name: "change_status", nullable: false })
  changeStatus!: TestResultStatus

  // Why the result failed (issue #454): distinguishes infrastructure errors (dead browser
  // session, storage) from genuine story failures. Only set when changeStatus is "failed"
  @Column({ type: "text", name: "error_kind", nullable: true })
  errorKind!: TestResultErrorKind | null

  // Human-readable error detail accompanying errorKind. Only set when changeStatus is "failed"
  @Column({ type: "text", name: "error_message", nullable: true })
  errorMessage!: string | null

  // Troubleshooting context captured at failure time (issue #475): console tail, in-flight
  // requests, best-effort failure screenshot key. Only set when changeStatus is "failed"
  @Column({ type: "jsonb", name: "diagnostics", nullable: true })
  diagnostics!: TestResultDiagnostics | null

  @CreateDateColumn({ name: "created_at", type: "timestamptz", nullable: false })
  createdAt!: Date

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz", nullable: false })
  updatedAt!: Date
}
