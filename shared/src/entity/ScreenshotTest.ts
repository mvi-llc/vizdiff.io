import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm"

import type { Project } from "./Project"
import type { ScreenshotTestStatus } from "./types"
import type { TestResult } from "./TestResult"
import type { WorkTask } from "./WorkTask"

@Entity("screenshot_tests")
@Index("IDX_project_id_commit_sha", ["project.id", "commitSha"])
@Index("IDX_project_id_branch", ["project.id", "branch"])
@Index("IDX_project_id_build_number", ["project.id", "buildNumber"], { unique: true })
// Supports the worker's startup orphan reclaim (issue #451): "find running builds owned by a
// given worker id". Name must match the migration (AddBuildWorkerTracking) exactly so
// `synchronize: true` (tests) and migrations produce identical schemas.
@Index("IDX_screenshot_tests_status_worker", ["status", "workerId"])
export class ScreenshotTest {
  @PrimaryGeneratedColumn()
  id!: number

  @ManyToOne("Project", { onDelete: "CASCADE", nullable: false, eager: true })
  @JoinColumn({ name: "project_id", referencedColumnName: "id" })
  project!: Project

  @Column({ name: "build_number", type: "integer", nullable: false })
  buildNumber!: number

  @Column({ name: "build_duration_sec", type: "double precision", nullable: true })
  buildDurationSec!: number | null

  @OneToMany("TestResult", "screenshotTest")
  testResults!: Promise<TestResult[]>

  @OneToMany("WorkTask", "screenshotTest")
  workTasks!: Promise<WorkTask[]>

  @Column({ name: "commit_sha", type: "text", nullable: false, update: false })
  commitSha!: string

  @Column({ type: "text", nullable: false })
  branch!: string

  @Column({ name: "base_commit_sha", type: "text", nullable: true })
  baseCommitSha!: string | null

  @Column({ name: "base_branch", type: "text", nullable: true })
  baseBranch!: string | null

  // Pull Request number (GitHub) or Merge Request IID (GitLab)
  @Column({ name: "pr_number", type: "integer", nullable: true })
  prNumber!: number | null

  @Column({ name: "upload_id", type: "text", unique: true, nullable: false })
  uploadId!: string

  @Column({ type: "text", nullable: false })
  status!: ScreenshotTestStatus

  // VCS status ID (GitHub Check Run ID or GitLab Commit Status ID)
  @Column({ name: "vcs_status_id", type: "bigint", nullable: true })
  vcsStatusId!: number | null

  // Legacy alias for backward compatibility
  get githubCheckRunId(): number | null {
    return this.vcsStatusId
  }

  set githubCheckRunId(value: number | null) {
    this.vcsStatusId = value
  }

  @Column({ name: "tag", type: "text", nullable: true })
  tag!: string | null

  @Column({ name: "total_changes", type: "integer", nullable: true })
  totalChanges!: number | null

  @Column({ name: "browser_version", type: "text", nullable: true })
  browserVersion!: string | null

  // Identity of the worker currently processing this build (issue #451). Set when the build
  // flips to "running"; used at worker startup to reclaim builds orphaned by a fatal exit.
  @Column({ name: "worker_id", type: "text", nullable: true })
  workerId!: string | null

  // Last time the in-flight build reported render progress (issue #452). Shipped with #451 but
  // not yet written; the stuck-build sweeper reads COALESCE(last_progress_at, updated_at) so it
  // degrades to updated_at until the progress watchdog lands.
  @Column({ name: "last_progress_at", type: "timestamptz", nullable: true })
  lastProgressAt!: Date | null

  @CreateDateColumn({ name: "created_at", type: "timestamptz", nullable: false })
  createdAt!: Date

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz", nullable: false })
  updatedAt!: Date

  toString(): string {
    return `[test_id=${this.id} ${this.project.repoUrl}#${this.commitSha}]`
  }
}
