import type { Meta, StoryObj, StoryContext } from "@storybook/nextjs"
import { http, HttpResponse } from "msw"
import type { JSX, ComponentType } from "react"

import type { ProjectResponse } from "@/lib/apiTypes"

import ThemeWrapper from "./ThemeWrapper"
import { catchAllHandler, githubUserHandler, userHandler } from "./mocks"
import SettingsComponent from "../pages/settings"

type StoryArgs = {
  mode?: "light" | "dark"
}

const oneMinuteAgo = Math.floor(Date.now() / 1000) - 60

const mockProjects: ProjectResponse[] = [
  {
    id: 1,
    name: "vizdiff.io",
    vcsProvider: "gitlab",
    repoUrl: "https://gitlab.com/vizdiff-io/vizdiff.io",
    key: "",
    token: "abc123def456",
    ownerId: 123,
    createdStampSec: oneMinuteAgo - 3600 * 24 * 30, // 1 month ago
    lastBuildStampSec: oneMinuteAgo - 3600, // 1 hour ago
    builds: 42,
    tests: 156,
  },
  {
    id: 3,
    name: "MyAwesomeProject",
    vcsProvider: "gitlab",
    repoUrl: "https://gitlab.com/test/MyAwesomeProject",
    key: "",
    token: "ghi789jkl012",
    ownerId: 456,
    createdStampSec: oneMinuteAgo - 3600, // 1 hour ago
    lastBuildStampSec: oneMinuteAgo, // just now
    builds: 3,
    tests: 12,
  },
]

const meta: Meta<typeof SettingsComponent> = {
  title: "stories/pages/Settings",
  component: SettingsComponent,
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
    msw: {
      handlers: [
        userHandler,
        http.get("/api/projects", () => HttpResponse.json(mockProjects)),
        http.delete("/api/users/me", () =>
          HttpResponse.json(
            { error: "Failed to delete account. Please try again." },
            { status: 400 },
          ),
        ),
        catchAllHandler,
      ],
    },
  },
}

export default meta
type Story = StoryObj<typeof SettingsComponent>

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

// GitHub-mode deployment: the user is authenticated via GitHub, so the account shows the linked
// GitHub username. (Default deployments are OIDC/GitLab and show no GitHub username.)
export const GitHubUser: Story = {
  args: {
    mode: "light",
  },
  parameters: {
    msw: {
      handlers: [
        githubUserHandler,
        http.get("/api/projects", () => HttpResponse.json(mockProjects)),
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
