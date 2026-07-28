import { Project, User } from "shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Database } from "./database"
import { findProjectsByGitLabId, findProjectsByRepo } from "./endpoints/webhooks"

/**
 * Integration tests for monorepo support (issue #443): multiple projects per VCS repository,
 * distinguished by the `key` column. Exercises the real Postgres unique index
 * (vcs_provider, repo_id, gitlab_host, key) and the webhook fan-out lookups.
 */
describe("multiple projects per repository (monorepo support)", () => {
  beforeAll(async () => {
    await Database()
  })

  afterAll(async () => {
    const db = await Database()
    if (db.isInitialized) {
      await db.destroy()
    }
  })

  async function createUser(): Promise<User> {
    const db = await Database()
    const user = db.manager.create(User, {
      authSubject: `mono-${Date.now()}-${Math.random()}`,
      authProvider: "dev",
      email: `mono-${Date.now()}-${Math.random()}@example.com`,
    })
    await db.manager.save(user)
    return user
  }

  function makeProject(user: User, overrides: Partial<Project>): Project {
    return Object.assign(new Project(), {
      user,
      name: "Monorepo Project",
      token: `mono-token-${Date.now()}-${Math.random()}`,
      vcsProvider: "gitlab",
      repoUrl: "https://gitlab.example.com/group/monorepo",
      gitlabHost: "https://gitlab.example.com",
      key: "",
      ...overrides,
    })
  }

  it("allows multiple projects for the same repo when keys differ", async () => {
    const db = await Database()
    const user = await createUser()
    const repoId = Math.floor(Math.random() * 1_000_000_000)

    const defaultProject = makeProject(user, { repoId })
    await db.manager.save(defaultProject)

    const webProject = makeProject(user, { repoId, key: "web", name: "Web Storybook" })
    await db.manager.save(webProject)

    const uiLibProject = makeProject(user, { repoId, key: "ui-lib", name: "UI Lib Storybook" })
    await db.manager.save(uiLibProject)

    const rows = await db.manager.find(Project, { where: { repoId } })
    expect(rows).toHaveLength(3)
    expect(rows.map((p) => p.key).sort()).toEqual(["", "ui-lib", "web"])
  })

  it("still rejects a duplicate project without a key (empty-key default)", async () => {
    const db = await Database()
    const user = await createUser()
    const repoId = Math.floor(Math.random() * 1_000_000_000)

    await db.manager.save(makeProject(user, { repoId }))
    await expect(db.manager.save(makeProject(user, { repoId }))).rejects.toThrow(
      /duplicate key value violates unique constraint/i,
    )
  })

  it("rejects a duplicate project with the same key", async () => {
    const db = await Database()
    const user = await createUser()
    const repoId = Math.floor(Math.random() * 1_000_000_000)

    await db.manager.save(makeProject(user, { repoId, key: "web" }))
    await expect(db.manager.save(makeProject(user, { repoId, key: "web" }))).rejects.toThrow(
      /duplicate key value violates unique constraint/i,
    )
  })

  it("findProjectsByGitLabId fans out to every project for the repo", async () => {
    const db = await Database()
    const user = await createUser()
    const repoId = Math.floor(Math.random() * 1_000_000_000)

    await db.manager.save(makeProject(user, { repoId }))
    await db.manager.save(makeProject(user, { repoId, key: "web" }))
    // A project on a different host must NOT match
    await db.manager.save(
      makeProject(user, {
        repoId,
        key: "other-host",
        gitlabHost: "https://gitlab.other.example.com",
      }),
    )

    const matches = await findProjectsByGitLabId(repoId, "https://gitlab.example.com")
    expect(matches.map((p) => p.key).sort()).toEqual(["", "web"])
  })

  it("findProjectsByRepo fans out to every project matching the repo URL", async () => {
    const db = await Database()
    const user = await createUser()
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`
    const repoName = `monorepo-${suffix}`
    const repoUrl = `https://github.com/acme/${repoName}`
    const repoId = Math.floor(Math.random() * 1_000_000_000)

    await db.manager.save(
      makeProject(user, { vcsProvider: "github", gitlabHost: null, repoUrl, repoId }),
    )
    await db.manager.save(
      makeProject(user, { vcsProvider: "github", gitlabHost: null, repoUrl, repoId, key: "web" }),
    )

    const matches = await findProjectsByRepo("acme", repoName, "github")
    expect(matches.map((p) => p.key).sort()).toEqual(["", "web"])
  })
})
