import ReportProblemIcon from "@mui/icons-material/ReportProblem"
import { Box, Paper, Typography } from "@mui/material"
import Image from "next/image"
import { type JSX, useState } from "react"

import type { TestResultResponse } from "@/lib/apiTypes"
import { changeStatusColor, changeStatusMessage } from "@/lib/changeStatus"

interface TestResultCardProps {
  result: TestResultResponse
  onOpenFullscreen: (result: TestResultResponse) => void
  isPriority?: boolean
}

export default function TestResultCard({
  result,
  onOpenFullscreen,
  isPriority = false,
}: TestResultCardProps): JSX.Element {
  const [screenshotError, setScreenshotError] = useState(false)
  const [diffMaskError, setDiffMaskError] = useState(false)

  return (
    <Paper
      onClick={() => onOpenFullscreen(result)}
      sx={{
        p: 2,
        height: "100%",
        minHeight: 280,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        position: "relative",
        cursor: "pointer",
        overflow: "hidden",
        "&:hover": { bgcolor: "var(--five-percent-opacity)" },
      }}
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          minHeight: 32,
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 400,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            direction: "rtl",
            textAlign: "left",
          }}
        >
          {result.name}
        </Typography>
      </Box>

      {/* Screenshot container */}
      <Box sx={{ position: "relative", width: "100%", pt: "56.25%" }}>
        <Box
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "var(--five-percent-opacity)",
          }}
        >
          {screenshotError ? (
            <ReportProblemIcon
              color="error"
              sx={{ fontSize: 40, color: "var(--text-secondary)" }}
            />
          ) : result.screenshotUrl ? (
            <Image
              src={result.screenshotUrl}
              alt={`Screenshot for ${result.name}`}
              fill
              style={{ objectFit: "contain" }}
              sizes="(max-width: 600px) 100vw, (max-width: 900px) 50vw, 33vw"
              priority={isPriority}
              onError={() => setScreenshotError(true)}
            />
          ) : (
            <Typography variant="caption" sx={{ color: "var(--text-secondary)" }}>
              No Screenshot
            </Typography>
          )}
          {/* Diff Mask (only shown if URL exists and hasn't errored, and screenshot hasn't errored) */}
          {!screenshotError && !diffMaskError && result.diffMaskUrl && (
            <Box
              sx={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                overflow: "hidden",
              }}
            >
              <Image
                src={result.diffMaskUrl}
                alt={`Diff mask for ${result.name}`}
                fill
                style={{
                  objectFit: "contain",
                  filter: "brightness(0) invert(1) sepia(1) hue-rotate(45deg) saturate(10000%)",
                }}
                onError={() => setDiffMaskError(true)}
              />
            </Box>
          )}
        </Box>
      </Box>

      {/* Status indicator */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, marginTop: "auto" }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: changeStatusColor(result.changeStatus),
          }}
        />
        <Typography variant="body2">
          {changeStatusMessage(result.changeStatus, result.diffRatio ?? 0, result.errorKind)}
        </Typography>
      </Box>
    </Paper>
  )
}
