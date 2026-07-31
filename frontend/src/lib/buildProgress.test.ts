import { describe, expect, it } from "vitest"

import type { TestResultResponse } from "./apiTypes"
import { STALLED_THRESHOLD_MS, computeProgress, isStalled } from "./buildProgress"

function makeResult(
  id: number,
  changeStatus: TestResultResponse["changeStatus"],
): TestResultResponse {
  return {
    id,
    name: `story-${id}`,
    changeStatus,
    screenshotUrl: `https://example.com/${id}.png`,
    createdStampSec: 1700000000,
  }
}

describe("computeProgress", () => {
  it("returns all zeroes for an empty result set", () => {
    expect(computeProgress([])).toEqual({ completed: 0, ok: 0, changed: 0, failed: 0 })
  })

  it("partitions results into ok / changed / failed buckets", () => {
    const results = [
      makeResult(1, "unchanged"),
      makeResult(2, "unchanged"),
      makeResult(3, "unchanged"),
      // "changed" and "new" both count as changed: both need reviewer attention.
      makeResult(4, "changed"),
      makeResult(5, "new"),
      makeResult(6, "failed"),
    ]
    expect(computeProgress(results)).toEqual({ completed: 6, ok: 3, changed: 2, failed: 1 })
  })

  it("counts every result toward completed", () => {
    const results = [makeResult(1, "new"), makeResult(2, "failed")]
    expect(computeProgress(results).completed).toBe(2)
  })
})

describe("isStalled", () => {
  it("is false when the age is unknown", () => {
    expect(isStalled(undefined)).toBe(false)
  })

  it("is false just under the threshold", () => {
    expect(isStalled(STALLED_THRESHOLD_MS - 1)).toBe(false)
  })

  it("is false at exactly the threshold", () => {
    expect(isStalled(STALLED_THRESHOLD_MS)).toBe(false)
  })

  it("is true just over the threshold", () => {
    expect(isStalled(STALLED_THRESHOLD_MS + 1)).toBe(true)
  })
})
