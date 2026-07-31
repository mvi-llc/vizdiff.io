import type { Meta, StoryObj, StoryContext } from "@storybook/nextjs"
import { http, HttpResponse } from "msw"
import type { JSX, ComponentType } from "react"

import type { TestResponse } from "@/lib/apiTypes"

import ThemeWrapper from "./ThemeWrapper"
import {
  screenshot01Base,
  screenshot01Diff,
  screenshot01New,
  screenshot02Diff,
  screenshot02New,
  screenshot03New,
} from "./assets"
import { catchAllHandler, userHandler } from "./mocks"
import BuildComponent from "../pages/build"

type StoryArgs = {
  mode?: "light" | "dark"
}

const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60
const mockBuildData: TestResponse = {
  id: 123,
  projectId: 456,
  projectName: "Cat Photos",
  buildNumber: 42,
  vcsProvider: "github",
  repoUrl: "https://github.com/cats/cat-photos",
  commitSha: "abc123433dcad967ac73e8219f3c9fa5d2b49a70",
  branch: "main",
  prNumber: 123,
  uploadId: "upload-123",
  status: "approved",
  initiatedStampSec: oneMinuteAgo,
  testResults: [
    {
      id: 1,
      name: "pages/Signup/Checkout Error",
      changeStatus: "changed",
      screenshotUrl: screenshot01New.src,
      ancestorScreenshotUrl: screenshot01Base.src,
      diffMaskUrl: screenshot01Diff.src,
      diffRatio: 0.0932,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 2,
      name: "components/Excessively Long Path/With Many Words/And Many More Words/Dashboard/Dashboard Test",
      changeStatus: "unchanged",
      screenshotUrl: screenshot02New.src,
      ancestorScreenshotUrl: screenshot02New.src,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 3,
      name: "pages/Build/Light",
      changeStatus: "new",
      screenshotUrl: screenshot03New.src,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 4,
      name: "Original Screenshot Evicted",
      changeStatus: "changed",
      screenshotUrl: screenshot02New.src,
      ancestorScreenshotUrl: "/static/media/broken.png",
      diffMaskUrl: screenshot02Diff.src,
      diffRatio: 0.02,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 5,
      name: "Diff Mask Evicted",
      changeStatus: "changed",
      screenshotUrl: screenshot02New.src,
      ancestorScreenshotUrl: screenshot02New.src,
      diffMaskUrl: "/static/media/broken.png",
      diffRatio: 0.101,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 6,
      name: "All Screenshots Evicted",
      changeStatus: "changed",
      screenshotUrl: "/static/media/broken.png",
      ancestorScreenshotUrl: "/static/media/broken.png",
      diffMaskUrl: "/static/media/broken.png",
      diffRatio: 0.2473,
      createdStampSec: oneMinuteAgo,
    },
  ],
  parent: {
    id: 789,
    projectId: 456,
    projectName: "Cat Photos",
    buildNumber: 41,
    vcsProvider: "github",
    repoUrl: "https://github.com/cats/cat-photos",
    branch: "main",
    commitSha: "def456",
    uploadId: "upload-122",
    status: "no_changes",
    initiatedStampSec: oneMinuteAgo - 3600,
  },
}

const mockBuildDataDemo: TestResponse = {
  id: 123,
  projectId: 456,
  projectName: "My Project",
  buildNumber: 42,
  vcsProvider: "github",
  repoUrl: "https://github.com/my-org/my-project",
  commitSha: "abc123433dcad967ac73e8219f3c9fa5d2b49a70",
  branch: "main",
  prNumber: 123,
  uploadId: "upload-123",
  status: "unapproved",
  initiatedStampSec: oneMinuteAgo,
  testResults: [
    {
      id: 1,
      name: "pages/Signup/Checkout Error",
      changeStatus: "changed",
      screenshotUrl: screenshot01New.src,
      ancestorScreenshotUrl: screenshot01Base.src,
      diffMaskUrl: screenshot01Diff.src,
      diffRatio: 0.0932,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 2,
      name: "pages/Home/Dark",
      changeStatus: "new",
      screenshotUrl: screenshot02New.src,
      createdStampSec: oneMinuteAgo,
    },
    {
      id: 3,
      name: "pages/Build/Light",
      changeStatus: "unchanged",
      screenshotUrl: screenshot03New.src,
      ancestorScreenshotUrl: screenshot03New.src,
      createdStampSec: oneMinuteAgo,
    },
  ],
  parent: {
    id: 789,
    projectId: 456,
    projectName: "Cat Photos",
    buildNumber: 41,
    vcsProvider: "github",
    repoUrl: "https://github.com/cats/cat-photos",
    branch: "main",
    commitSha: "def456",
    uploadId: "upload-122",
    status: "no_changes",
    initiatedStampSec: oneMinuteAgo - 3600,
  },
}

const meta: Meta<typeof BuildComponent> = {
  title: "stories/pages/Build",
  component: BuildComponent,
  argTypes: {
    mode: {
      control: "radio",
      options: ["light", "dark"],
      defaultValue: "light",
    },
  },
  decorators: [
    (Story: ComponentType, context: StoryContext<StoryArgs>): JSX.Element => {
      return (
        <ThemeWrapper mode={context.args.mode ?? "light"} isAuthenticated={true}>
          <Story />
        </ThemeWrapper>
      )
    },
  ],
  parameters: {
    nextjs: {
      router: {
        query: { id: "123" },
      },
    },
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () => HttpResponse.json(mockBuildData)),
        catchAllHandler,
      ],
    },
  },
}

export default meta
type Story = StoryObj<typeof BuildComponent>

export const Light: Story = {
  args: {
    mode: "light",
  },
}

export const Dark: Story = {
  args: {
    mode: "dark",
  },
}

export const Pending: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({ ...mockBuildData, status: "pending", testResults: [] }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const Running: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({
            ...mockBuildData,
            status: "running",
            // Partial results stream in while the build runs; the page shows the one finished
            // card plus "1 / 6" live counts, a segmented progress bar, skeleton placeholders
            // for the 5 outstanding stories, and the worker caption (issues #476/#477). The
            // static lastProgressAgeMs keeps the story deterministic for Chromatic.
            expectedStoryCount: 6,
            lastProgressAgeMs: 5000,
            workerId: "worker-abc123",
            testResults: mockBuildData.testResults.slice(0, 1),
          }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const RunningPreEnumeration: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({
            ...mockBuildData,
            status: "running",
            // No expectedStoryCount and no results yet: the worker has not enumerated the
            // storybook's stories, so the page shows an indeterminate "Preparing stories…" bar
            // instead of counts or skeletons (issue #477).
            lastProgressAgeMs: 5000,
            workerId: "worker-abc123",
            testResults: [],
          }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const RunningStalled: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({
            ...mockBuildData,
            status: "running",
            // lastProgressAgeMs past STALLED_THRESHOLD_MS (90s): the page adds the
            // warning-colored "No progress for 120s — build may be stalled" line (issue #477).
            expectedStoryCount: 6,
            lastProgressAgeMs: 120000,
            workerId: "worker-abc123",
            testResults: mockBuildData.testResults.slice(0, 1),
          }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const NoTests: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({ ...mockBuildData, status: "unapproved", testResults: [] }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const NoChanges: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({ ...mockBuildData, status: "no_changes" }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const Unapproved: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () =>
          HttpResponse.json({ ...mockBuildData, status: "unapproved" }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const Denied: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () => HttpResponse.json({ ...mockBuildData, status: "denied" })),
        catchAllHandler,
      ],
    },
  },
}

export const Failed: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () => HttpResponse.json({ ...mockBuildData, status: "failed" })),
        catchAllHandler,
      ],
    },
  },
}

export const Demo: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", () => HttpResponse.json(mockBuildDataDemo)),
        catchAllHandler,
      ],
    },
  },
}

export const Loading: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/tests/:id", async () => {
          await new Promise(() => {
            // wait forever
          })
        }),
        catchAllHandler,
      ],
    },
  },
}

export const Mobile: Story = {
  args: {
    mode: "light",
  },
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "mobile1" } },
}
