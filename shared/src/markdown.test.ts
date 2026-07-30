import { describe, expect, it } from "vitest"

import type { ScreenshotTest } from "./entity/ScreenshotTest"
import type { TestResult } from "./entity/TestResult"
import type { TestResultErrorKind } from "./entity/types"
import { isInfraErrorKind } from "./entity/types"
import { createMarkdownForBuildResult } from "./markdown"

function makeBuild(): ScreenshotTest {
  return {
    id: 1,
    buildNumber: 7,
    commitSha: "abc1234",
    branch: "feature",
    baseCommitSha: "def5678",
    baseBranch: "main",
    status: "unapproved",
    uploadId: "upload-1",
    project: {
      repoUrl: "https://github.com/acme/widgets",
      vcsProvider: "github",
    },
  } as ScreenshotTest
}

function makeResult(
  build: ScreenshotTest,
  name: string,
  changeStatus: TestResult["changeStatus"],
  errorKind: TestResultErrorKind | null = null,
): TestResult {
  return {
    id: 100,
    name,
    storyId: name,
    screenshotTest: build,
    baselineImageUrl: "https://example.com/base.png",
    newImageUrl: "https://example.com/new.png",
    diffImageUrl: null,
    diffRatio: changeStatus === "changed" ? 0.1 : null,
    changeStatus,
    errorKind,
    errorMessage: errorKind ? `error of kind ${errorKind}` : null,
  } as TestResult
}

describe("isInfraErrorKind", () => {
  it("classifies infra kinds as infra and story kinds as not", () => {
    for (const kind of ["browser-timeout", "browser-gone", "screenshot-failed", "storage"]) {
      expect(isInfraErrorKind(kind)).toBe(true)
    }
    for (const kind of [
      "story-error",
      "render-timeout",
      "story-load-timeout",
      "ready-signal-timeout",
      "unknown",
      "not-a-kind",
    ]) {
      expect(isInfraErrorKind(kind)).toBe(false)
    }
    expect(isInfraErrorKind(null)).toBe(false)
    expect(isInfraErrorKind(undefined)).toBe(false)
  })
})

describe("createMarkdownForBuildResult", () => {
  it("reports failed counts without an infra suffix when no infra failures exist", () => {
    const build = makeBuild()
    const results = [
      makeResult(build, "Button", "unchanged"),
      makeResult(build, "Card", "failed", "story-error"),
    ]

    const { summary, text } = createMarkdownForBuildResult(build, results)

    expect(summary).toContain("⚠️ 1 test failed to render.")
    expect(summary).not.toContain("infrastructure")
    expect(text).toContain("🔴 Failed")
    expect(text).not.toContain("🔴 Failed (infrastructure)")
  })

  it("splits failed counts into story-vs-infra and labels infra rows", () => {
    const build = makeBuild()
    const results = [
      makeResult(build, "Button", "failed", "story-error"),
      // Legacy rows written before issue #454 have no error kind: treated as story failures.
      makeResult(build, "Card", "failed", null),
      makeResult(build, "Dialog", "failed", "browser-gone"),
      makeResult(build, "Toolbar", "changed"),
    ]

    const { summary, text } = createMarkdownForBuildResult(build, results)

    expect(summary).toContain("⚠️ 3 tests failed to render (1 due to infrastructure error).")

    // Per-row status: only the infra-kind failure gets the "(infrastructure)" label.
    expect(text).toMatch(/\*\*Dialog\*\*[\s\S]*?🔴 Failed \(infrastructure\)/)
    expect(text).toMatch(/\*\*Button\*\*[\s\S]*?🔴 Failed\n/)
    expect(text).toMatch(/\*\*Card\*\*[\s\S]*?🔴 Failed\n/)
  })

  it("pluralizes the infra suffix", () => {
    const build = makeBuild()
    const results = [
      makeResult(build, "Dialog", "failed", "browser-gone"),
      makeResult(build, "Toolbar", "failed", "browser-timeout"),
    ]

    const { summary } = createMarkdownForBuildResult(build, results)

    expect(summary).toContain("⚠️ 2 tests failed to render (2 due to infrastructure errors).")
  })
})
