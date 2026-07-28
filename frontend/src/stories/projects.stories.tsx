import type { Meta, StoryObj, StoryContext } from "@storybook/nextjs"
import { http, HttpResponse } from "msw"
import type { JSX, ComponentType } from "react"

import type { ProjectResponse, ScreenshotTestResponse } from "@/lib/apiTypes"

import ThemeWrapper from "./ThemeWrapper"
import { catchAllHandler, userHandler } from "./mocks"
import ProjectsComponent from "../pages/projects"

type StoryArgs = {
  mode?: "light" | "dark"
}

const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60
const mockProjects: ProjectResponse[] = [
  {
    id: 1,
    name: "vizdiff.io",
    vcsProvider: "github",
    repoUrl: "https://github.com/vizdiff-io/vizdiff.io",
    key: "",
    token: "abc123def456",
    ownerId: 123,
    createdStampSec: oneMinuteAgo - 3600 * 24 * 30, // 1 month ago
    lastBuildStampSec: oneMinuteAgo - 3600, // 1 hour ago
    builds: 42,
    tests: 156,
  },
  {
    id: 2,
    name: "Design System",
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    key: "",
    token: "def456ghi789",
    ownerId: 123,
    createdStampSec: oneMinuteAgo - 3600 * 24 * 7, // 1 week ago
    lastBuildStampSec: oneMinuteAgo - 3600 * 24, // 1 day ago
    builds: 1,
    tests: 1,
  },
  {
    id: 3,
    name: "MyAwesomeProject",
    vcsProvider: "github",
    repoUrl: "https://github.com/test/MyAwesomeProject",
    key: "",
    token: "ghi789jkl012",
    ownerId: 456,
    createdStampSec: oneMinuteAgo - 3600, // 1 hour ago
    lastBuildStampSec: oneMinuteAgo, // just now
    builds: 3,
    tests: 12,
  },
  {
    id: 4,
    name: "Marketing Site",
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    key: "",
    token: "jkl012mno345",
    ownerId: 456,
    createdStampSec: oneMinuteAgo - 3600 * 24 * 7, // 1 week ago
    lastBuildStampSec: oneMinuteAgo - 3600 * 24, // 1 day ago
    builds: 9001,
    tests: 42,
  },
]
const mockActivity: ScreenshotTestResponse[] = [
  {
    id: 1,
    projectId: 1,
    projectName: "vizdiff.io",
    buildNumber: 6,
    vcsProvider: "github",
    repoUrl: "https://github.com/vizdiff-io/vizdiff.io",
    commitSha: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
    branch: "main",
    baseCommitSha: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
    baseBranch: "main",
    uploadId: "upload-6",
    status: "pending",
    tag: "v1.0.0",
    initiatedStampSec: oneMinuteAgo - 3600, // 1 hour ago
    buildDurationSec: 100,
  },
  {
    id: 2,
    projectId: 2,
    projectName: "Cat Photos",
    buildNumber: 5,
    vcsProvider: "github",
    repoUrl: "https://github.com/example/example-project",
    commitSha: "84a516841ba77a5b4648de2cd0dfcb30ea46dbb4",
    branch: "someone/made/a/very/long/branch/name/that/doesnt/fit/in/the/activity/list",
    uploadId: "upload-5",
    status: "running",
    initiatedStampSec: oneMinuteAgo - 3600 * 24, // 1 day ago
    buildDurationSec: 100,
  },
  {
    id: 3,
    projectId: 3,
    projectName: "MyAwesomeProject",
    buildNumber: 4,
    vcsProvider: "github",
    repoUrl: "https://github.com/test/MyAwesomeProject",
    commitSha: "3c363836cf4e16666669a25da280a1865c2d2874",
    branch: "main",
    uploadId: "upload-4",
    status: "no_changes",
    initiatedStampSec: oneMinuteAgo - 3600 * 24 * 30, // 1 month ago
    buildDurationSec: 100,
  },
  {
    id: 4,
    projectId: 4,
    projectName: "MyAwesomeProject Except It Has A Very Long Name",
    buildNumber: 3,
    vcsProvider: "github",
    repoUrl: "https://github.com/test/MyAwesomeProject",
    commitSha: "58e6b3a414a1e090dfc6029add0f3555ccba127f",
    branch: "main",
    uploadId: "upload-3",
    status: "failed",
    initiatedStampSec: oneMinuteAgo - 3600 * 24 * 30, // 1 month ago
    buildDurationSec: 100,
  },
  {
    id: 5,
    projectId: 5,
    projectName: "MyAwesomeProject",
    buildNumber: 2,
    vcsProvider: "github",
    repoUrl: "https://github.com/test/MyAwesomeProject",
    commitSha: "4a0a19218e082a343a1b17e5333409af9d98f0f5",
    branch: "main",
    uploadId: "upload-2",
    status: "approved",
    initiatedStampSec: oneMinuteAgo - 3600 * 24 * 30, // 1 month ago
    buildDurationSec: 100,
  },
  {
    id: 6,
    projectId: 6,
    projectName: "MyAwesomeProject",
    buildNumber: 1,
    vcsProvider: "github",
    repoUrl: "https://github.com/test/MyAwesomeProject",
    commitSha: "54fd1711209fb1c0781092374132c66e79e2241b",
    branch: "main",
    uploadId: "upload-1",
    status: "unapproved",
    initiatedStampSec: oneMinuteAgo - 3600 * 24 * 30, // 1 month ago
    buildDurationSec: 100,
  },
]

const meta: Meta<typeof ProjectsComponent> = {
  title: "stories/pages/Projects",
  component: ProjectsComponent,
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
    msw: {
      handlers: [
        userHandler,
        http.get("/api/projects", () => HttpResponse.json(mockProjects)),
        http.get("/api/activity", () => HttpResponse.json(mockActivity)),
        catchAllHandler,
      ],
    },
  },
}

export default meta
type Story = StoryObj<typeof ProjectsComponent>

export const Light: Story = {
  args: { mode: "light" },
}

export const Dark: Story = {
  args: { mode: "dark" },
}

export const EmptyProjects: Story = {
  args: { mode: "light" },
  parameters: {
    msw: {
      handlers: [
        userHandler,
        http.get("/api/projects", () => HttpResponse.json([])),
        http.get("/api/activity", () => HttpResponse.json([])),
        catchAllHandler,
      ],
    },
  },
  render: () => <ProjectsComponent />,
}

export const Mobile: Story = {
  args: { mode: "light" },
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "mobile1" } },
}
