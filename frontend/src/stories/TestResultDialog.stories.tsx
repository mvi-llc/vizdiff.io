import type { Meta, StoryContext, StoryObj } from "@storybook/nextjs"
import type { JSX, ComponentType } from "react"

import ThemeWrapper from "./ThemeWrapper"
import { screenshot01New } from "./assets"
import { catchAllHandler, userHandler } from "./mocks"
import TestResultDialog from "../components/TestResultDialog"
import type { TestResultResponse } from "../lib/apiTypes"

type StoryArgs = {
  mode?: "light" | "dark"
  result: TestResultResponse
}

// Fixed timestamps so the console tail renders stable HH:MM:SS.mmm prefixes.
const failureEpochMs = 1735689600000 // 2025-01-01T00:00:00Z

/** A failed result carrying the full worker-captured diagnostics payload (issue #475). */
const failedWithDiagnostics: TestResultResponse = {
  id: 1,
  name: "stories/pages/signup--checkout-error",
  changeStatus: "failed",
  screenshotUrl: "",
  errorKind: "render-timeout",
  errorMessage:
    "Timed out after 30000ms waiting for the story to finish rendering. The page still had 2 " +
    "network requests in flight when the screenshot deadline was reached.",
  diagnostics: {
    console: [
      { level: "log", text: "Fetching /api/checkout/session…", stampMs: failureEpochMs + 150 },
      {
        level: "warn",
        text: "Slow resource: https://cdn.example.com/fonts/inter.woff2 took more than 10s",
        stampMs: failureEpochMs + 12400,
      },
      {
        level: "error",
        text: "Uncaught TypeError: Cannot read properties of undefined (reading 'total')\n    at CheckoutSummary (checkout-summary.tsx:42:18)",
        stampMs: failureEpochMs + 29750,
      },
    ],
    pendingRequests: [
      { url: "https://api.stripe.example/v1/checkout/sessions", pendingMs: 29750 },
      { url: "https://cdn.example.com/fonts/inter.woff2", pendingMs: 12400 },
    ],
    failureScreenshotUrl: screenshot01New.src,
  },
  createdStampSec: failureEpochMs / 1000,
}

/** A failed result from before diagnostics capture existed: only errorKind/errorMessage set. */
const failedNoDiagnostics: TestResultResponse = {
  id: 2,
  name: "stories/pages/signup--checkout-error",
  changeStatus: "failed",
  screenshotUrl: "",
  errorKind: "story-error",
  errorMessage: "Error: story threw during render: boom",
  createdStampSec: failureEpochMs / 1000,
}

const meta: Meta<StoryArgs> = {
  title: "stories/components/TestResultDialog",
  argTypes: {
    mode: {
      control: "radio",
      options: ["light", "dark"],
      defaultValue: "light",
    },
  },
  // Mount the dialog directly (NewProjectDialog pattern): a non-null `result` renders it open,
  // so no click-to-open play function is needed.
  render: (args): JSX.Element => (
    <TestResultDialog
      result={args.result}
      allResults={[args.result]}
      onNavigate={() => undefined}
      onClose={() => undefined}
    />
  ),
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
      handlers: [userHandler, catchAllHandler],
    },
  },
}

export default meta

type Story = StoryObj<StoryArgs>

// Failed result with the full diagnostics payload: error message, console tail (error/warn
// tinted), pending requests, and the failure-time screenshot in the main image slot.
export const FailedWithDiagnostics: Story = {
  args: { mode: "light", result: failedWithDiagnostics },
}

export const FailedWithDiagnosticsDark: Story = {
  args: { mode: "dark", result: failedWithDiagnostics },
}

// Regression: a failed result without diagnostics (pre-#475 rows) keeps today's rendering —
// error message block plus the "No Screenshot" placeholder, no diagnostics sections.
export const FailedNoDiagnostics: Story = {
  args: { mode: "light", result: failedNoDiagnostics },
}
