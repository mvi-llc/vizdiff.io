import { describe, expect, it } from "vitest"

import { classifyStoryError, StorageError, type ClassifiedStoryError } from "./errorClassify"
import { StoryRenderError, StoryRenderTimeoutError } from "./storyReady"

describe("classifyStoryError", () => {
  const cases: Array<{
    label: string
    err: unknown
    expected: Pick<ClassifiedStoryError, "errorClass" | "kind">
  }> = [
    // Rule 1: semantic story-render outcomes (issue #458)
    {
      label: "StoryRenderError",
      err: new StoryRenderError("story-a", "component threw"),
      expected: { errorClass: "story", kind: "story-error" },
    },
    {
      label: "StoryRenderTimeoutError (render)",
      err: new StoryRenderTimeoutError("story-a", 30_000, "render"),
      expected: { errorClass: "story", kind: "render-timeout" },
    },
    {
      label: "StoryRenderTimeoutError (ready-signal)",
      err: new StoryRenderTimeoutError("story-a", 30_000, "ready-signal"),
      expected: { errorClass: "story", kind: "ready-signal-timeout" },
    },
    // Rule 2: story/storybook load timeouts
    {
      label: "story load timeout",
      err: new Error("Story failed to load within 10s"),
      expected: { errorClass: "story", kind: "story-load-timeout" },
    },
    {
      label: "storybook load timeout",
      err: new Error("Storybook failed to load stories within 10s"),
      expected: { errorClass: "story", kind: "story-load-timeout" },
    },
    // Rule 3: storage
    {
      label: "StorageError",
      err: new StorageError("Failed to upload screenshot for story x to S3", new Error("boom")),
      expected: { errorClass: "infra", kind: "storage" },
    },
    // Rule 4: browser gone
    {
      label: "invalid session id",
      err: new Error("invalid session id"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "session deleted",
      err: new Error("session deleted"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "session not created",
      err: new Error("session not created"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "session not started",
      err: new Error("A session not started error"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "browsing context not found",
      err: new Error("browsing context with id 42 not found"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "browsing context discarded",
      err: new Error("browsing context 7F00 was discarded"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "no such window",
      err: new Error("no such window: target window already closed"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "WebSocket closed",
      err: new Error("WebSocket connection closed before command response"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "WebSocket not connected",
      err: new Error("WebSocket is not connected"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "ECONNREFUSED",
      err: new Error("connect ECONNREFUSED 127.0.0.1:4444"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "ECONNRESET",
      err: new Error("read ECONNRESET"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "EPIPE",
      err: new Error("write EPIPE"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "socket hang up",
      err: new Error("socket hang up"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "fetch failed",
      err: new Error("fetch failed"),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    {
      label: "err.name === WebDriverRequestError",
      err: Object.assign(new Error("something opaque"), { name: "WebDriverRequestError" }),
      expected: { errorClass: "infra", kind: "browser-gone" },
    },
    // Rule 5: command/screenshot timeouts
    {
      label: "BiDi command timeout (setViewport)",
      err: new Error(
        "Command browsingContext.setViewport with id 13494 (with the following parameter) timed out",
      ),
      expected: { errorClass: "infra", kind: "browser-timeout" },
    },
    {
      label: "BiDi command timeout (callFunction)",
      err: new Error("Command script.callFunction with id 13493 timed out"),
      expected: { errorClass: "infra", kind: "browser-timeout" },
    },
    {
      label: "screenshot timed out",
      err: new Error("Screenshot timed out after 10000ms for /tmp/x.png"),
      expected: { errorClass: "infra", kind: "screenshot-failed" },
    },
    {
      label: "screenshot failed after max retries",
      err: new Error("Screenshot failed after max retries"),
      expected: { errorClass: "infra", kind: "screenshot-failed" },
    },
    // Rule 6: default
    {
      label: "unrecognized Error",
      err: new Error("something else entirely"),
      expected: { errorClass: "story", kind: "unknown" },
    },
    {
      label: "non-Error value",
      err: "string error",
      expected: { errorClass: "story", kind: "unknown" },
    },
  ]

  it.each(cases)(
    "classifies $label as $expected.errorClass/$expected.kind",
    ({ err, expected }) => {
      const classified = classifyStoryError(err)
      expect(classified.errorClass).toBe(expected.errorClass)
      expect(classified.kind).toBe(expected.kind)
      expect(classified.message.length).toBeGreaterThan(0)
    },
  )

  it("carries the original error message", () => {
    expect(classifyStoryError(new Error("socket hang up")).message).toBe("socket hang up")
    expect(classifyStoryError("plain string").message).toBe("plain string")
  })

  it("ordering: a StoryRenderError whose message also matches an infra pattern stays story-class", () => {
    const err = new StoryRenderError("story-a", "fetch failed")
    expect(classifyStoryError(err)).toMatchObject({ errorClass: "story", kind: "story-error" })
  })

  it("StorageError exposes its cause", () => {
    const cause = new Error("NoSuchBucket")
    const err = new StorageError("upload failed", cause)
    expect(err.cause).toBe(cause)
    expect(err.name).toBe("StorageError")
  })
})
