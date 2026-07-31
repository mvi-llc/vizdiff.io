import ArrowBackIosNewIcon from "@mui/icons-material/ArrowBackIosNew"
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos"
import CloseIcon from "@mui/icons-material/Close"
import CompareIcon from "@mui/icons-material/Compare"
import GridViewIcon from "@mui/icons-material/GridView"
import LayersIcon from "@mui/icons-material/Layers"
import ReportProblemIcon from "@mui/icons-material/ReportProblem"
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material"
import Image from "next/image"
import { type JSX, useState, useEffect, useMemo, useCallback } from "react"

import type { TestResultResponse } from "@/lib/apiTypes"
import { changeStatusColor, changeStatusMessage } from "@/lib/changeStatus"

type ViewMode = "new" | "old" | "diff" | "split"

/** Format an epoch-milliseconds console timestamp as HH:MM:SS.mmm (local time). */
function formatConsoleStamp(stampMs: number): string {
  const date = new Date(stampMs)
  const pad = (value: number, width: number) => String(value).padStart(width, "0")
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`
}

/** Theme color for a console entry so errors/warnings stand out in the diagnostics tail. */
function consoleLevelColor(level: string): string | undefined {
  if (level === "error") {
    return "error.main"
  }
  if (level === "warn" || level === "warning") {
    return "warning.main"
  }
  return undefined
}

interface TestResultDialogProps {
  result: TestResultResponse | null
  allResults: TestResultResponse[]
  onNavigate: (newResult: TestResultResponse) => void
  onClose: () => void
}

export default function TestResultDialog({
  result,
  allResults,
  onNavigate,
  onClose,
}: TestResultDialogProps): JSX.Element | null {
  // 1. State
  const [viewMode, setViewMode] = useState<ViewMode>("diff")
  const [preferredViewMode, setPreferredViewMode] = useState<ViewMode>("diff")
  const [screenshotError, setScreenshotError] = useState(false)
  const [ancestorScreenshotError, setAncestorScreenshotError] = useState(false)
  const [diffMaskError, setDiffMaskError] = useState(false)

  // 2. Derived values (Memoized)
  const currentIndex = useMemo(() => {
    if (!result) {
      return -1
    }
    return allResults.findIndex((r) => r.id === result.id)
  }, [result, allResults])

  const canNavigatePrev = currentIndex > 0
  const canNavigateNext = currentIndex !== -1 && currentIndex < allResults.length - 1

  const hasAncestorScreenshot = result?.ancestorScreenshotUrl ? true : false
  const isNewStatus = result?.changeStatus === "new"
  const canShowOld = hasAncestorScreenshot && !isNewStatus
  const canShowDiff = hasAncestorScreenshot && !isNewStatus && (result?.diffMaskUrl ? true : false)

  // 3. Callbacks (Memoized)
  const handleNavigatePrev = useCallback(() => {
    if (canNavigatePrev) {
      const prevResult = allResults[currentIndex - 1]
      if (prevResult) {
        onNavigate(prevResult)
      }
    }
  }, [allResults, currentIndex, onNavigate, canNavigatePrev])

  const handleNavigateNext = useCallback(() => {
    if (canNavigateNext) {
      const nextResult = allResults[currentIndex + 1]
      if (nextResult) {
        onNavigate(nextResult)
      }
    }
  }, [allResults, currentIndex, onNavigate, canNavigateNext])

  const handleViewModeChange = useCallback(
    (_: React.MouseEvent<HTMLElement>, newMode: ViewMode | null) => {
      if (newMode) {
        setViewMode(newMode)
        setPreferredViewMode(newMode)
      }
    },
    [],
  )

  // 4. Effects
  // Reset errors when result changes
  useEffect(() => {
    setScreenshotError(false)
    setAncestorScreenshotError(false)
    setDiffMaskError(false)
  }, [result?.id])

  // Reset view mode based on availability and preference when result changes
  useEffect(() => {
    if (!result) {
      return
    }

    let targetMode = viewMode // Start with current mode

    // 1. Check if preferred mode is valid
    if (preferredViewMode === "old" && canShowOld) {
      targetMode = "old"
    } else if (preferredViewMode === "diff" && canShowDiff) {
      targetMode = "diff"
    } else if (preferredViewMode === "split" || preferredViewMode === "new") {
      // "split" and "new" are always available
      targetMode = preferredViewMode
    } else {
      // 2. Preferred mode is not valid, check if current mode is still valid
      if ((viewMode === "old" && !canShowOld) || (viewMode === "diff" && !canShowDiff)) {
        // Current mode is also invalid, default to "new"
        targetMode = "new"
      }
      // Otherwise, current mode is 'new' or 'split' and remains valid, so targetMode stays as viewMode
    }

    if (viewMode !== targetMode) {
      setViewMode(targetMode)
    }
  }, [result, viewMode, preferredViewMode, canShowOld, canShowDiff])

  // Keyboard navigation effect
  useEffect(() => {
    if (!result) {
      return // Don't add listener if dialog is closed
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        handleNavigatePrev()
      } else if (event.key === "ArrowRight") {
        handleNavigateNext()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [result, handleNavigatePrev, handleNavigateNext])

  // 5. Early return (after all hooks)
  if (!result) {
    return null
  }

  // Failure troubleshooting context (issue #475): only present for failed results. When the
  // worker captured a failure-time screenshot, show it in the "new" image slot (the regular new
  // screenshot is empty for failed results) labeled as such.
  const diagnostics = result.changeStatus === "failed" ? result.diagnostics : undefined
  const failureScreenshotUrl = diagnostics?.failureScreenshotUrl
  const newScreenshotUrl = failureScreenshotUrl ?? result.screenshotUrl
  const newScreenshotAlt = failureScreenshotUrl
    ? `Failure screenshot for ${result.name}`
    : undefined

  // 6. JSX
  return (
    <Dialog
      open={!!result}
      onClose={onClose}
      maxWidth={false}
      fullWidth
      slotProps={{
        paper: {
          sx: {
            margin: 0,
            width: { xs: "96.5%", md: "calc(100% - 32px)" },
            maxWidth: "96.5%",
            height: "calc(100vh - 64px)",
            maxHeight: "calc(100vh - 64px)",
            display: "flex",
            flexDirection: "column",
            fontSize: { xs: "0.875rem", sm: "1rem" },
          },
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          justifyContent: "space-between",
          alignItems: { xs: "flex-start", sm: "center" },
          flex: "0 0 auto",
          p: 2,
          pb: 1,
          gap: { xs: 0.5, sm: 1 },
        }}
      >
        <Typography
          variant="h6"
          component="div"
          sx={{
            whiteSpace: "nowrap",
            overflow: "clip",
            textOverflow: "ellipsis",
            direction: "rtl",
            textAlign: "left",
            display: { xs: "block", sm: "none" },
            width: "100%",
          }}
        >
          {result.name}
        </Typography>
        <Box
          sx={{
            flex: "1 1 65%",
            maxWidth: "65%",
            overflow: "hidden",
          }}
        >
          <Typography
            variant="h6"
            component="div"
            sx={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              direction: "rtl",
              textAlign: "left",
              display: { xs: "none", sm: "block" },
            }}
          >
            {result.name}
          </Typography>
          <Typography variant="body2" color={changeStatusColor(result.changeStatus)}>
            {changeStatusMessage(result.changeStatus, result.diffRatio ?? 0, result.errorKind)}
          </Typography>
        </Box>
        <Box
          sx={{
            display: "flex",
            gap: 1,
            alignItems: "center",
            flexShrink: 0,
            width: { xs: "100%", sm: "auto" },
            justifyContent: { xs: "space-between", sm: "flex-end" },
          }}
        >
          <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <IconButton onClick={handleNavigatePrev} disabled={!canNavigatePrev} size="small">
              <ArrowBackIosNewIcon fontSize="small" />
            </IconButton>
            <Typography variant="body2" sx={{ minWidth: "4ch", textAlign: "center" }}>
              {`${currentIndex + 1}/${allResults.length}`}
            </Typography>
            <IconButton onClick={handleNavigateNext} disabled={!canNavigateNext} size="small">
              <ArrowForwardIosIcon fontSize="small" />
            </IconButton>
          </Box>
          <ToggleButtonGroup
            value={viewMode}
            exclusive
            onChange={handleViewModeChange}
            size="small"
            color="primary"
            sx={{
              display: { xs: "none", sm: "flex" },
            }}
          >
            <ToggleButton value="old" disabled={!canShowOld}>
              <LayersIcon sx={{ mr: 1 }} />
              Base
            </ToggleButton>
            <ToggleButton value="new">
              <LayersIcon sx={{ mr: 1 }} />
              New
            </ToggleButton>
            <ToggleButton value="diff" disabled={!canShowDiff}>
              <CompareIcon sx={{ mr: 1 }} />
              Diff
            </ToggleButton>
            <ToggleButton value="split">
              <GridViewIcon sx={{ mr: 1 }} />
              2-up
            </ToggleButton>
          </ToggleButtonGroup>
          <IconButton onClick={onClose} size="small">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent
        sx={{ flex: 1, p: 2, overflow: "hidden", display: "flex", flexDirection: "column", gap: 2 }}
      >
        {result.changeStatus === "failed" && result.errorMessage && (
          <Box
            component="pre"
            sx={{
              flex: "0 0 auto",
              m: 0,
              p: 1.5,
              maxHeight: "30%",
              overflow: "auto",
              fontFamily: "monospace",
              fontSize: "0.8125rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              bgcolor: "var(--five-percent-opacity)",
              color: "error.main",
            }}
          >
            {result.errorMessage}
          </Box>
        )}
        {diagnostics && diagnostics.console.length > 0 && (
          <Box sx={{ flex: "0 0 auto" }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Console output
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                maxHeight: "30vh",
                overflow: "auto",
                fontFamily: "monospace",
                fontSize: "0.8125rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                bgcolor: "var(--five-percent-opacity)",
              }}
            >
              {diagnostics.console.map((entry, index) => (
                <Box
                  key={index}
                  component="span"
                  sx={{ display: "block", color: consoleLevelColor(entry.level) }}
                >
                  {`${formatConsoleStamp(entry.stampMs)} [${entry.level}] ${entry.text}`}
                </Box>
              ))}
            </Box>
          </Box>
        )}
        {diagnostics && diagnostics.pendingRequests.length > 0 && (
          <Box sx={{ flex: "0 0 auto" }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Pending requests at failure
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1.5,
                maxHeight: "20vh",
                overflow: "auto",
                fontFamily: "monospace",
                fontSize: "0.8125rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                bgcolor: "var(--five-percent-opacity)",
              }}
            >
              {diagnostics.pendingRequests.map((request, index) => (
                <Box key={index} component="span" sx={{ display: "block" }}>
                  {`${request.url} — pending ${(request.pendingMs / 1000).toFixed(1)}s`}
                </Box>
              ))}
            </Box>
          </Box>
        )}
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          {viewMode === "split" ? (
            <Box sx={{ display: "flex", width: "100%", gap: 2, overflow: "hidden" }}>
              <Box
                sx={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  position: "relative",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: "var(--five-percent-opacity)",
                }}
              >
                {ancestorScreenshotError ? (
                  <ReportProblemIcon
                    color="error"
                    sx={{ fontSize: 40, color: "var(--text-secondary)" }}
                  />
                ) : result.ancestorScreenshotUrl ? (
                  <Image
                    src={result.ancestorScreenshotUrl}
                    alt={`Base screenshot for ${result.name}`}
                    fill
                    sizes="50vw"
                    style={{ objectFit: "contain" }}
                    priority
                    onError={() => setAncestorScreenshotError(true)}
                  />
                ) : (
                  <Typography variant="caption" sx={{ color: "var(--text-secondary)" }}>
                    No Base Screenshot
                  </Typography>
                )}
              </Box>
              <Box
                sx={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  position: "relative",
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
                ) : newScreenshotUrl ? (
                  <>
                    <Image
                      src={newScreenshotUrl}
                      alt={newScreenshotAlt ?? `New version of ${result.name}`}
                      fill
                      sizes="50vw"
                      style={{ objectFit: "contain" }}
                      priority
                      onError={() => setScreenshotError(true)}
                    />
                    {failureScreenshotUrl && (
                      <Typography
                        variant="caption"
                        sx={{
                          position: "absolute",
                          bottom: 8,
                          bgcolor: "var(--five-percent-opacity)",
                          px: 1,
                          color: "var(--text-secondary)",
                        }}
                      >
                        Failure screenshot
                      </Typography>
                    )}
                  </>
                ) : (
                  <Typography variant="caption" sx={{ color: "var(--text-secondary)" }}>
                    No New Screenshot
                  </Typography>
                )}
              </Box>
            </Box>
          ) : (
            <Box
              sx={{
                position: "relative",
                width: "100%",
                height: "100%",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: "var(--five-percent-opacity)",
              }}
            >
              {viewMode === "old" ? (
                ancestorScreenshotError ? (
                  <ReportProblemIcon
                    color="error"
                    sx={{ fontSize: 40, color: "var(--text-secondary)" }}
                  />
                ) : result.ancestorScreenshotUrl ? (
                  <Image
                    src={result.ancestorScreenshotUrl}
                    alt={`Base screenshot for ${result.name}`}
                    fill
                    sizes="100vw"
                    style={{ objectFit: "contain" }}
                    priority
                    onError={() => setAncestorScreenshotError(true)}
                  />
                ) : (
                  <Typography variant="caption" sx={{ color: "var(--text-secondary)" }}>
                    No Base Screenshot
                  </Typography>
                )
              ) : screenshotError ? (
                <ReportProblemIcon
                  color="error"
                  sx={{ fontSize: 40, color: "var(--text-secondary)" }}
                />
              ) : newScreenshotUrl ? (
                <>
                  <Image
                    src={newScreenshotUrl}
                    alt={newScreenshotAlt ?? `Screenshot for ${result.name}`}
                    fill
                    sizes="100vw"
                    style={{ objectFit: "contain" }}
                    priority
                    onError={() => setScreenshotError(true)}
                  />
                  {failureScreenshotUrl && (
                    <Typography
                      variant="caption"
                      sx={{
                        position: "absolute",
                        bottom: 8,
                        bgcolor: "var(--five-percent-opacity)",
                        px: 1,
                        color: "var(--text-secondary)",
                      }}
                    >
                      Failure screenshot
                    </Typography>
                  )}
                </>
              ) : (
                <Typography variant="caption" sx={{ color: "var(--text-secondary)" }}>
                  No Screenshot
                </Typography>
              )}

              {viewMode === "diff" && !screenshotError && !diffMaskError && result.diffMaskUrl && (
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
                    sizes="100vw"
                    style={{
                      objectFit: "contain",
                      filter: "brightness(0) invert(1) sepia(1) hue-rotate(45deg) saturate(10000%)",
                    }}
                    priority
                    onError={() => setDiffMaskError(true)}
                  />
                </Box>
              )}
            </Box>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  )
}
