import { Gitlab } from "@gitbeaker/rest"
import type { GitLabHostConfig } from "shared"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import {
  getGitLabClient,
  getGitLabHostConfig,
  updateGitLabCommitStatus,
  type GitLabStatusState,
} from "./gitlab"
import { log } from "./log"

const mockEnvironment = vi.hoisted(() => ({
  GITLAB_HOST: "https://gitlab.com",
  APP_URL: "https://vizdiff.io",
  ENABLE_VCS_STATUS: false, // Disabled in tests by default
  IS_PRODUCTION: false,
  IS_STAGING: false,
  IS_TEST: true,
}))

// Mock external dependencies
vi.mock("@gitbeaker/rest")
vi.mock("./environment", () => mockEnvironment)
vi.mock("./log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Configure per-host service tokens before the module's lazy/cached parse of process.env.
process.env.GITLAB_HOSTS = JSON.stringify([
  { host: "https://gitlab.com", token: "glpat-service-token", rejectUnauthorized: true },
  { host: "https://gitlab.company.com", token: "glpat-corp-token", rejectUnauthorized: false },
])

describe("gitlab (worker)", () => {
  let mockGitlabClient: {
    Commits: { editStatus: ReturnType<typeof vi.fn> }
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockGitlabClient = {
      Commits: {
        editStatus: vi.fn().mockResolvedValue({}),
      },
    }

    // vitest 4 invokes mock implementations with `new`, so the implementation
    // must be a constructable `function` rather than a (non-constructable) arrow.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- cast keeps the constructable function form vitest 4 requires
    vi.mocked(Gitlab).mockImplementation(function (this: unknown) {
      return mockGitlabClient as unknown as InstanceType<typeof Gitlab>
    } as unknown as typeof Gitlab)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe("getGitLabHostConfig", () => {
    it("resolves the configured token for a host", () => {
      expect(getGitLabHostConfig("https://gitlab.com")?.token).toBe("glpat-service-token")
    })

    it("returns undefined for an unconfigured host", () => {
      expect(getGitLabHostConfig("https://gitlab.unknown.example.com")).toBeUndefined()
    })
  })

  describe("getGitLabClient", () => {
    it("creates a client using the host config's service token", () => {
      const cfg: GitLabHostConfig = {
        host: "https://gitlab.com",
        token: "glpat-service-token",
        rejectUnauthorized: true,
      }
      getGitLabClient(cfg)
      expect(Gitlab).toHaveBeenCalledWith(
        expect.objectContaining({ host: "https://gitlab.com", token: "glpat-service-token" }),
      )
    })
  })

  describe("updateGitLabCommitStatus", () => {
    it("skips update when ENABLE_VCS_STATUS is false", async () => {
      await updateGitLabCommitStatus({
        projectId: 123,
        commitSha: "abc123",
        gitlabHost: "https://gitlab.com",
        state: "success",
        testId: 1,
        name: "vizdiff/visual-tests",
        description: "All tests passed",
      })

      expect(mockGitlabClient.Commits.editStatus).not.toHaveBeenCalled()
    })

    describe("with ENABLE_VCS_STATUS enabled", () => {
      const statusUpdate = {
        projectId: 123,
        commitSha: "abc123",
        gitlabHost: "https://gitlab.com",
        testId: 1,
        name: "vizdiff/visual-tests",
        description: "Tests running",
      }
      const transitionMessage =
        'Cannot transition status via :run from :running (Reason(s): Status cannot transition via "run")'

      beforeEach(() => {
        mockEnvironment.ENABLE_VCS_STATUS = true
      })

      afterEach(() => {
        mockEnvironment.ENABLE_VCS_STATUS = false
      })

      it("downgrades a redundant running->running transition error to debug", async () => {
        mockGitlabClient.Commits.editStatus.mockRejectedValue(new Error(transitionMessage))

        await updateGitLabCommitStatus({ ...statusUpdate, state: "running" })

        expect(log.error).not.toHaveBeenCalled()
        expect(log.debug).toHaveBeenCalledWith(
          expect.objectContaining({ err: expect.any(Error) as Error, state: "running" }),
          "GitLab commit status already running; skipping redundant transition",
        )
      })

      it("detects the transition error nested in a GitbeakerRequestError cause description", async () => {
        mockGitlabClient.Commits.editStatus.mockRejectedValue(
          new Error("Bad Request", { cause: { description: transitionMessage } }),
        )

        await updateGitLabCommitStatus({ ...statusUpdate, state: "running" })

        expect(log.error).not.toHaveBeenCalled()
        expect(log.debug).toHaveBeenCalledWith(
          expect.objectContaining({ state: "running" }),
          "GitLab commit status already running; skipping redundant transition",
        )
      })

      it("still logs an error when the transition error occurs for a non-running state", async () => {
        mockGitlabClient.Commits.editStatus.mockRejectedValue(new Error(transitionMessage))

        await updateGitLabCommitStatus({ ...statusUpdate, state: "success" })

        expect(log.debug).not.toHaveBeenCalled()
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ state: "success" }),
          "Failed to update GitLab commit status",
        )
      })

      it("logs unrelated errors with structured context", async () => {
        const unrelated = new Error("500 Internal Server Error")
        mockGitlabClient.Commits.editStatus.mockRejectedValue(unrelated)

        await updateGitLabCommitStatus({ ...statusUpdate, state: "running" })

        expect(log.debug).not.toHaveBeenCalled()
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({
            err: unrelated,
            gitlabHost: "https://gitlab.com",
            projectId: 123,
            commitSha: "abc123",
            state: "running",
            name: "vizdiff/visual-tests",
          }),
          "Failed to update GitLab commit status",
        )
      })
    })
  })

  describe("GitLabStatusState type", () => {
    it("includes all valid states", () => {
      const validStates: GitLabStatusState[] = [
        "pending",
        "running",
        "success",
        "failed",
        "canceled",
      ]
      expect(validStates).toHaveLength(5)
    })
  })
})
