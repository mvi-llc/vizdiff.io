import { config as configEnv } from "dotenv-flow"
import * as path from "path"
import { fileURLToPath } from "url"

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const envPath = path.join(dirname, "..")

// Load the `worker/.env*` file into process.env
configEnv({
  path: envPath,
  default_node_env: "development",
  silent: process.env.NODE_ENV === "test",
})

export const IS_PRODUCTION = process.env.NODE_ENV === "production"
export const IS_STAGING = process.env.NODE_ENV === "staging"
export const IS_TEST = process.env.NODE_ENV === "test"

// Product version, baked into the image by the release workflow (release.yml) via the
// VIZDIFF_VERSION build-arg. "dev" for local/main/edge builds. Reported to Postgres (worker_status)
// so the api can surface it via GET /api/version.
export const VIZDIFF_VERSION = process.env.VIZDIFF_VERSION ?? "dev"

// Port of an already-running chromedriver to connect to. The worker container's start.sh launches
// chromedriver on 4444 and the image sets CHROMEDRIVER_PORT=4444, so a containerized worker connects
// to it regardless of NODE_ENV. When unset (e.g. local `yarn dev`/`yarn screenshot` without a
// separate chromedriver), it is left undefined so WebdriverIO manages its own driver. Decoupled
// from NODE_ENV so self-hosted workers aren't forced to NODE_ENV=production just to render.
export const CHROMEDRIVER_PORT = process.env.CHROMEDRIVER_PORT
  ? parseInt(process.env.CHROMEDRIVER_PORT, 10)
  : undefined
// Allow VCS status posting in dev mode for testing (defaults to true in prod/staging)
export const ENABLE_VCS_STATUS =
  process.env.ENABLE_VCS_STATUS != undefined
    ? process.env.ENABLE_VCS_STATUS === "true"
    : IS_PRODUCTION || IS_STAGING

export const POSTGRES_USER = process.env.POSTGRES_USER ?? "postgres"
export const POSTGRES_HOST = process.env.POSTGRES_HOST ?? "localhost"
export const POSTGRES_DATABASE = process.env.POSTGRES_DATABASE ?? "vizdiff"
export const POSTGRES_PASS = process.env.POSTGRES_PASS ?? "postgres"
export const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT ?? "5432", 10)

export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME ?? "vizdiffio-testing"

// Optional custom S3 endpoint for non-AWS object stores (e.g. MinIO in standalone/air-gapped
// mode). When unset, the AWS SDK uses the real S3 endpoint. Path-style addressing defaults on
// whenever a custom endpoint is set (MinIO requires it) and can be overridden explicitly.
export const S3_ENDPOINT = process.env.S3_ENDPOINT
export const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE
  ? process.env.S3_FORCE_PATH_STYLE === "true"
  : Boolean(S3_ENDPOINT)
// Extra options spread into `new S3Client(...)`; empty object for real AWS S3.
export const S3_CLIENT_CONFIG: { endpoint?: string; forcePathStyle?: boolean } = S3_ENDPOINT
  ? { endpoint: S3_ENDPOINT, forcePathStyle: S3_FORCE_PATH_STYLE }
  : {}

// Screenshots live in a private bucket and are embedded in PR/MR comments via presigned URLs.
// Long TTL (S3 SigV4 max of 7 days) because the comments persist after the build completes.
export const VCS_IMAGE_URL_TTL_SECONDS = parseInt(
  process.env.VCS_IMAGE_URL_TTL_SECONDS ?? "604800",
  10,
)

// GitHub support is disabled by default in self-hosted deployments.
export const GITHUB_ENABLED = process.env.GITHUB_ENABLED === "true"

// GitHub API settings (only used when GITHUB_ENABLED)
export const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? ""
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? ""
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ""
export const GITHUB_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY ?? ""
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? ""

// GitLab API settings.
// Per-host service tokens are configured via GITLAB_HOSTS (parsed in gitlab.ts via shared/gitlabHosts).
// GITLAB_HOST is the default host used to resolve a token when a task carries no explicit host.
export const GITLAB_HOST = process.env.GITLAB_HOST ?? "https://gitlab.com"

// Application URLs
export const APP_URL = process.env.APP_URL ?? "https://vizdiff.io"

export const WORKER_HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT ?? "3003", 10)

// Number of stories rendered concurrently within a single ingest task (issue #152, Phase 1b).
// Each unit is one independent headless-Chrome session in the per-ingest browser pool, so this is
// also the peak number of Chrome processes per in-flight build. Rendering now genuinely runs in
// parallel (the former process-wide browser mutex is gone — each session is single-threaded by
// construction), so raising this scales render throughput at a roughly linear cost in browser RAM.
//
// Defaults to 1 (one session, sequential): identical browser-memory footprint to the previous
// effective behavior, where the mutex serialized all rendering anyway. Raise it for faster builds
// once the host has headroom for N× Chrome RSS (size against the build timeout / memory guards from
// issue #33). Values < 1 are clamped to 1.
export const WORKER_STORY_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.WORKER_STORY_CONCURRENCY ?? "1", 10) || 1,
)

// Baseline-comparison changed/unchanged decision. A story is marked "changed" when BOTH floors
// are met: at least WORKER_CHANGED_MIN_PIXELS differing pixels AND a diff ratio of at least
// WORKER_CHANGED_THRESHOLD. The previous behavior was a lone hardcoded 0.1% ratio, which dilutes
// with screenshot area: the same one-word text change flags on a button-sized story but passes
// silently on a full-page story (~0.05% of a 1M-pixel screenshot). An absolute pixel floor is
// size-independent, so the default is 10 pixels with the ratio floor at 0 (rendering is
// deterministic per worker image, so a handful of pixels is a real change, while <10 tolerates
// stray single-pixel jitter). Deployments with nondeterministic stories can raise either floor.
// Neither affects the capture-stabilization loop. Invalid values fall back to the defaults.
const rawChangedMinPixels = parseInt(process.env.WORKER_CHANGED_MIN_PIXELS ?? "10", 10)
export const WORKER_CHANGED_MIN_PIXELS =
  Number.isFinite(rawChangedMinPixels) && rawChangedMinPixels >= 0 ? rawChangedMinPixels : 10
const rawChangedThreshold = parseFloat(process.env.WORKER_CHANGED_THRESHOLD ?? "0")
export const WORKER_CHANGED_THRESHOLD =
  Number.isFinite(rawChangedThreshold) && rawChangedThreshold >= 0 && rawChangedThreshold <= 1
    ? rawChangedThreshold
    : 0

// Opt-in software (SwiftShader) WebGL for story rendering (issue #447). The worker image ships
// SwiftShader (Alpine's chromium-swiftshader package), but WebGL stays off by default because
// SwiftShader is in-process software rasterization driven by untrusted story content — a larger
// attack surface than no GL at all — so deployments that don't render WebGL stories shouldn't pay
// for it. Disabled → screenshot sessions launch with --disable-webgl (WebGL-dependent stories fall
// into their error boundaries, as before); enabled → --enable-unsafe-swiftshader, and stories get
// deterministic software WebGL (same SwiftShader version → same pixels), which suits visual
// regression well.
export const WORKER_ENABLE_WEBGL = process.env.WORKER_ENABLE_WEBGL === "true"

// Whitespace-separated extra Chrome flags appended to the screenshot session launch args, after
// the hardening and WebGL flags (issue #447). An operator escape hatch for browser tuning without
// an image rebuild. Appending can only add flags, not remove the hardening set; use
// WORKER_ENABLE_WEBGL (not this) to control WebGL.
export const WORKER_CHROME_EXTRA_ARGS: readonly string[] = (
  process.env.WORKER_CHROME_EXTRA_ARGS ?? ""
)
  .split(/\s+/)
  .filter((arg) => arg.length > 0)
// --- Upload sanity / safety limits -------------------------------------------------------------
// These guard untrusted storybook uploads against zip-bombs, path traversal, pathological story
// counts, and oversized identifiers. All are configurable via env with sane defaults. A value of
// 0 (or a non-positive / non-numeric value) disables the corresponding limit.

function intEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw == undefined || raw.trim() === "") {
    return defaultValue
  }
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed < 0) {
    return defaultValue
  }
  return parsed
}

// Maximum number of stories processed from a single upload. Protects the worker and the database
// from a runaway number of screenshots. Default 1000.
export const MAX_STORIES_PER_UPLOAD = intEnv("MAX_STORIES_PER_UPLOAD", 1000)

// Maximum number of files (entries) allowed in an uploaded tarball. Default 50000.
export const MAX_TARBALL_FILES = intEnv("MAX_TARBALL_FILES", 50_000)

// Maximum total uncompressed size of all extracted files (zip-bomb guard). Default 1 GiB.
export const MAX_EXTRACTED_BYTES = intEnv("MAX_EXTRACTED_BYTES", 1024 * 1024 * 1024)

// Maximum size of any single extracted file. Default 256 MiB.
export const MAX_TARBALL_ENTRY_BYTES = intEnv("MAX_TARBALL_ENTRY_BYTES", 256 * 1024 * 1024)

// Maximum length of any single path inside the tarball. Default 4096.
export const MAX_TARBALL_PATH_LENGTH = intEnv("MAX_TARBALL_PATH_LENGTH", 4096)

// Maximum length of a story id / name / title before it is rejected. Default 2048.
export const MAX_STORY_IDENTIFIER_LENGTH = intEnv("MAX_STORY_IDENTIFIER_LENGTH", 2048)
// Maximum wall-clock duration for a single storybook build before it is aborted. A build that
// exceeds this is almost always stuck or pathologically large, so the task is treated as a
// non-retryable failure (see worker.ts). Default: 15 minutes.
export const BUILD_TIMEOUT_MS = parseInt(process.env.BUILD_TIMEOUT_MS ?? `${15 * 60 * 1000}`, 10)

// After a build timeout aborts the browser sessions, how long to wait for the in-flight render to
// actually unwind (running its `finally` blocks, which return each session to the browser pool)
// before declaring it unrecoverable and exiting the worker so the orchestrator restarts a clean
// process. Force-closing the sessions should reject the stuck WebDriver commands almost
// immediately, so this only needs to cover the unwind. Default: 10 seconds.
export const BUILD_ABORT_GRACE_MS = parseInt(process.env.BUILD_ABORT_GRACE_MS ?? `${10 * 1000}`, 10)

// Resident set size (bytes) past which a build logs a memory-pressure warning. Purely
// observational; it does not abort the build. Default: 2 GiB.
export const BUILD_MEMORY_WARN_BYTES = parseInt(
  process.env.BUILD_MEMORY_WARN_BYTES ?? `${2 * 1024 * 1024 * 1024}`,
  10,
)

// --- Build lifecycle hardening (issue #451) ----------------------------------------------------

// Upper bound on the best-effort "fail the build + post the failed VCS status" work that runs
// just before a fatal `process.exit(1)` (wedged render after a build timeout). The exit must not
// be delayed indefinitely by a slow database or VCS API, so the failsafe is raced against this
// timer. Default: 5 seconds.
export const WORKER_FATAL_FAILSAFE_TIMEOUT_MS = intEnv("WORKER_FATAL_FAILSAFE_TIMEOUT_MS", 5000)

// Maximum number of times a task may be claimed (task_queue.attempts) before the startup orphan
// reclaim fails the build outright instead of requeueing it. Bounds the crash loop where a build
// reliably wedges the worker: each restart re-runs the build until this many attempts have been
// burned. Default: 3.
export const WORKER_MAX_TASK_ATTEMPTS = intEnv("WORKER_MAX_TASK_ATTEMPTS", 3)

// Consider a "running" build stuck once its last activity (COALESCE(last_progress_at,
// updated_at)) is older than this many minutes. Minutes-scale relative to BUILD_TIMEOUT_MS (15
// minutes by default): a healthy build either finishes or is failed by the timeout well within
// this window, so anything older is orphaned. Replaces the former fixed 2-hour threshold.
// Default: 15 minutes.
export const WORKER_STUCK_RUNNING_MINUTES = intEnv("WORKER_STUCK_RUNNING_MINUTES", 15)

// Consider a "pending" build stuck once updated_at is older than this many minutes. Pending
// builds legitimately queue behind other work, so this stays conservative. Default: 240 minutes
// (4 hours).
export const WORKER_STUCK_PENDING_MINUTES = intEnv("WORKER_STUCK_PENDING_MINUTES", 240)
// --- Screenshot retention reaper (#79) ---
// The reaper deletes screenshot builds (and their S3 objects) older than the retention window,
// while always keeping the most recent N builds per project so a rarely-built project is never
// left without history. Disabled by default because it is destructive: an operator must opt in.
export const RETENTION_REAPER_ENABLED = process.env.RETENTION_REAPER_ENABLED === "true"
// Builds whose newest activity is older than this many days are eligible for deletion.
export const RETENTION_DAYS = Math.max(1, parseInt(process.env.RETENTION_DAYS ?? "90", 10) || 90)
// Always retain at least this many most-recent builds per project, regardless of age.
export const RETENTION_KEEP_LAST_N = Math.max(
  0,
  parseInt(process.env.RETENTION_KEEP_LAST_N ?? "10", 10) || 0,
)
// Upper bound on builds reaped per sweep, to keep each tick bounded.
export const RETENTION_MAX_BUILDS_PER_SWEEP = Math.max(
  1,
  parseInt(process.env.RETENTION_MAX_BUILDS_PER_SWEEP ?? "200", 10) || 200,
)
// Minimum interval between retention sweeps (ms). The worker tick is frequent; the reaper only
// needs to run periodically. Defaults to once per hour.
export const RETENTION_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  parseInt(process.env.RETENTION_SWEEP_INTERVAL_MS ?? "3600000", 10) || 3_600_000,
)
