import type { Meta, StoryObj, StoryContext } from "@storybook/nextjs"
import { http, HttpResponse } from "msw"
import type { JSX, ComponentType } from "react"

import type {
  BuildsListResponse,
  ProjectResponse,
  ScreenshotTestSummaryResponse,
} from "@/lib/apiTypes"

import ThemeWrapper from "./ThemeWrapper"
import { catchAllHandler, userHandler } from "./mocks"
import ProjectComponent from "../pages/project"

type StoryArgs = {
  mode?: "light" | "dark"
}

const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60
const mockProject: ProjectResponse = {
  id: 456,
  name: "Cat Photos",
  vcsProvider: "github",
  repoUrl: "https://github.com/example/example-project",
  key: "",
  token: "abc123def456",
  ownerId: 123,
  createdStampSec: oneMinuteAgo - 3600 * 24, // 1 day ago
  lastBuildStampSec: oneMinuteAgo,
  builds: 15,
  tests: 45,
}

const mockBuilds: ScreenshotTestSummaryResponse[] = [
  {
    id: 4,
    projectId: 456,
    projectName: "Cat Photos",
    buildNumber: 3,
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    commitSha: "d462c7658f276eaa61cd5ca522bc5988e16e429f",
    branch:
      "some/branch/with-a-very-long-name/that-needs-to-be-truncated/or-else-it-will-break-the-layout",
    prNumber: 789,
    uploadId: "123",
    initiatedStampSec: oneMinuteAgo,
    status: "pending",
    components: 12,
    stories: 45,
    changes: 3,
  },
  {
    id: 3,
    projectId: 456,
    projectName: "Cat Photos",
    buildNumber: 2,
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    commitSha: "6d2157c11dde1c14d701bbbcb1ea27062b3adf69",
    branch: "main",
    prNumber: 123,
    uploadId: "122",
    components: 12,
    stories: 45,
    changes: 0,
    initiatedStampSec: oneMinuteAgo - 3600, // 1 hour ago
    status: "approved",
    tag: "Infrastructure upgrade",
  },
  {
    id: 2,
    projectId: 456,
    projectName: "Cat Photos",
    buildNumber: 1,
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    commitSha: "1a2363533dcad967ac73e8219f3c9fa5d2b49a70",
    branch: "main",
    uploadId: "121",
    components: 1,
    stories: 1,
    changes: 1,
    initiatedStampSec: oneMinuteAgo - 3600 * 24, // 1 day ago
    status: "unapproved",
  },
  {
    id: 1,
    projectId: 456,
    projectName: "Cat Photos",
    buildNumber: 1,
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    commitSha: "1a2363533dcad967ac73e8219f3c9fa5d2b49a70",
    branch: "main",
    prNumber: 456,
    uploadId: "121",
    components: 10,
    stories: 40,
    changes: 40,
    initiatedStampSec: oneMinuteAgo - 3600 * 24, // 1 day ago
    status: "no_changes",
  },
]

const meta: Meta<typeof ProjectComponent> = {
  title: "stories/pages/Project",
  component: ProjectComponent,
  argTypes: {
    mode: {
      control: "radio",
      options: ["light", "dark"],
      defaultValue: "light",
    },
  },
  decorators: [
    (Story: ComponentType, context: StoryContext<StoryArgs>): JSX.Element => {
      // Set authentication cookie for Storybook
      document.cookie = "authenticated=true; path=/"
      return (
        <ThemeWrapper mode={context.args.mode ?? "light"}>
          <Story />
        </ThemeWrapper>
      )
    },
  ],
  parameters: {
    nextjs: {
      router: {
        query: { id: "456" },
      },
    },
    msw: {
      handlers: [
        userHandler,
        http.get("/api/projects/:id", () => HttpResponse.json(mockProject)),
        http.get("/api/projects/:projectId/builds", () =>
          HttpResponse.json<BuildsListResponse>({ builds: mockBuilds, hasMore: false }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export default meta
type Story = StoryObj<typeof ProjectComponent>

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

export const NoBuilds: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/projects/:id", () => HttpResponse.json(mockProject)),
        http.get("/api/projects/:projectId/builds", () =>
          HttpResponse.json<BuildsListResponse>({ builds: [], hasMore: false }),
        ),
        catchAllHandler,
      ],
    },
  },
}

export const HasMore: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/projects/:id", () => HttpResponse.json(mockProject)),
        // First page reports more available; subsequent pages return the same builds for the demo.
        http.get("/api/projects/:projectId/builds", ({ request }) => {
          const offset = Number(new URL(request.url).searchParams.get("offset") ?? "0")
          return HttpResponse.json<BuildsListResponse>({
            builds: mockBuilds,
            hasMore: offset === 0,
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
