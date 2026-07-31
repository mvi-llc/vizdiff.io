import { Box, LinearProgress, Typography } from "@mui/material"
import type { JSX } from "react"

import type { TestResultResponse } from "@/lib/apiTypes"
import { computeProgress, isStalled } from "@/lib/buildProgress"

interface BuildProgressBarProps {
  results: TestResultResponse[]
  /** Total stories the build is expected to render; absent until the worker enumerates them. */
  expectedStoryCount?: number
  /** Server-computed ms since the worker's last progress heartbeat (issue #477). */
  lastProgressAgeMs?: number
  /** Identity of the worker currently rendering this build. */
  workerId?: string
}

/**
 * Live progress readout for a pending/running build (issue #477): a segmented bar of
 * ok/changed/failed results against the expected story count, plus stalled and worker hints.
 * Callers should only render this while the build is in flight.
 */
export default function BuildProgressBar({
  results,
  expectedStoryCount,
  lastProgressAgeMs,
  workerId,
}: BuildProgressBarProps): JSX.Element {
  const { completed, ok, changed, failed } = computeProgress(results)
  // Partial results can momentarily exceed a stale expected count between polls; never let the
  // remainder segment go negative.
  const total = Math.max(expectedStoryCount ?? 0, completed)
  const remaining = total - completed
  const stalled = isStalled(lastProgressAgeMs)

  return (
    <Box sx={{ mb: 3 }}>
      {expectedStoryCount == undefined ? (
        <>
          <LinearProgress sx={{ borderRadius: 1 }} />
          <Typography variant="body2" sx={{ mt: 1 }}>
            Preparing stories…
          </Typography>
        </>
      ) : (
        <>
          {/* Segmented bar: proportional flex segments per status, matching the change-status
              palette used by the result cards (success/warning/error). */}
          <Box
            sx={{
              display: "flex",
              height: 8,
              borderRadius: 1,
              overflow: "hidden",
              bgcolor: "action.hover",
            }}
          >
            {ok > 0 && <Box sx={{ flex: ok, bgcolor: "success.main" }} />}
            {changed > 0 && <Box sx={{ flex: changed, bgcolor: "warning.main" }} />}
            {failed > 0 && <Box sx={{ flex: failed, bgcolor: "error.main" }} />}
            {remaining > 0 && <Box sx={{ flex: remaining }} />}
          </Box>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {`${completed} / ${total} stories rendered`}
            {changed > 0 && ` • ${changed} changed`}
            {failed > 0 && ` • ${failed} failed`}
          </Typography>
        </>
      )}
      {stalled && lastProgressAgeMs != undefined && (
        <Typography variant="body2" sx={{ mt: 0.5, color: "warning.main" }}>
          {`No progress for ${Math.round(lastProgressAgeMs / 1000)}s — build may be stalled`}
        </Typography>
      )}
      {workerId != undefined && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {`worker: ${workerId}`}
        </Typography>
      )}
    </Box>
  )
}
