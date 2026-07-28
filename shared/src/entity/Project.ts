import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  JoinColumn,
  ManyToOne,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from "typeorm"

import type { ScreenshotTest } from "./ScreenshotTest"
import type { VCSProvider } from "./types"
import type { User } from "./User"

@Entity("projects")
// Multiple projects per repo are allowed (monorepo support, issue #443) as long as each has a
// distinct `key`. The default key is the empty string, so accidentally creating a second project
// for the same repo without an explicit key is still rejected — this preserves the old
// one-project-per-repo safety net for single-project setups. gitlabHost is part of the key to keep
// GitLab projects with the same numeric ID on different hosts distinct.
@Index("IDX_vcs_repo_host_key", ["vcsProvider", "repoId", "gitlabHost", "key"], { unique: true })
export class Project {
  @PrimaryGeneratedColumn()
  id!: number

  @ManyToOne("User", "projects", { onDelete: "CASCADE", nullable: false, eager: true })
  @JoinColumn({ name: "user_id", referencedColumnName: "id" })
  user!: User

  @OneToMany("ScreenshotTest", "project")
  screenshotTests!: Promise<ScreenshotTest[]>

  @Column({ type: "text", nullable: false })
  name!: string

  @Column({ type: "text", unique: true, nullable: false })
  token!: string

  // VCS provider type ("github" or "gitlab")
  @Column({ name: "vcs_provider", type: "text", nullable: false, default: "github" })
  vcsProvider!: VCSProvider

  // Generic repo ID (GitHub repo ID or GitLab project ID)
  @Column({ name: "repo_id", type: "bigint", nullable: false })
  @Index("IDX_repo_id", ["repoId"], { unique: false })
  repoId!: number

  // Generic repo URL (GitHub or GitLab repository URL)
  @Column({ name: "repo_url", type: "text", nullable: false })
  repoUrl!: string

  // GitLab host URL (only for vcs_provider='gitlab') - required to prevent cross-host
  // authorization bypass when a single VizDiff deployment serves multiple GitLab instances
  @Column({ name: "gitlab_host", type: "text", nullable: true })
  gitlabHost!: string | null

  // Optional per-repo discriminator for monorepos hosting multiple Storybook projects (issue
  // #443). Empty string (the default) means "the" project for the repo; a non-empty key
  // distinguishes additional projects and is appended to the VCS commit status context
  // (e.g. `vizdiff/visual-tests/<key>`) so each project reports an independent status.
  @Column({ name: "key", type: "text", nullable: false, default: "" })
  key!: string

  // Legacy GitHub-specific fields (aliases for backward compatibility)
  // These are computed properties that map to the new generic fields
  get githubRepoId(): number {
    return this.repoId
  }

  set githubRepoId(value: number) {
    this.repoId = value
  }

  get githubRepoUrl(): string {
    return this.repoUrl
  }

  set githubRepoUrl(value: string) {
    this.repoUrl = value
  }

  @Column({ name: "storybook_config", type: "jsonb", nullable: true })
  storybookConfig!: object | null

  @CreateDateColumn({ name: "created_at", type: "timestamptz", nullable: false })
  createdAt!: Date

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz", nullable: false })
  updatedAt!: Date
}
