import { githubCheckRunName, gitlabStatusContext, isValidProjectKey } from "shared"
import { describe, expect, it } from "vitest"

describe("gitlabStatusContext", () => {
  it("returns the historic context for projects without a key", () => {
    expect(gitlabStatusContext("")).toBe("vizdiff/visual-tests")
    expect(gitlabStatusContext(null)).toBe("vizdiff/visual-tests")
    expect(gitlabStatusContext(undefined)).toBe("vizdiff/visual-tests")
  })

  it("appends the project key for monorepo projects", () => {
    expect(gitlabStatusContext("web")).toBe("vizdiff/visual-tests/web")
    expect(gitlabStatusContext("ui-lib")).toBe("vizdiff/visual-tests/ui-lib")
  })
})

describe("githubCheckRunName", () => {
  it("returns the historic name for projects without a key", () => {
    expect(githubCheckRunName("")).toBe("Visual Tests")
    expect(githubCheckRunName(null)).toBe("Visual Tests")
    expect(githubCheckRunName(undefined)).toBe("Visual Tests")
  })

  it("appends the project key for monorepo projects", () => {
    expect(githubCheckRunName("web")).toBe("Visual Tests (web)")
  })
})

describe("isValidProjectKey", () => {
  it("accepts slug-like keys", () => {
    expect(isValidProjectKey("web")).toBe(true)
    expect(isValidProjectKey("ui-lib")).toBe(true)
    expect(isValidProjectKey("pkg.storybook_2")).toBe(true)
    expect(isValidProjectKey("A")).toBe(true)
    expect(isValidProjectKey("a".repeat(64))).toBe(true)
  })

  it("rejects the empty string (the 'no key' default is not an explicit key)", () => {
    expect(isValidProjectKey("")).toBe(false)
  })

  it("rejects keys with unsafe characters", () => {
    expect(isValidProjectKey("has space")).toBe(false)
    expect(isValidProjectKey("slash/y")).toBe(false)
    expect(isValidProjectKey(".leading-dot")).toBe(false)
    expect(isValidProjectKey("-leading-dash")).toBe(false)
    expect(isValidProjectKey("emoji🔥")).toBe(false)
    expect(isValidProjectKey("a".repeat(65))).toBe(false)
  })
})
