# VizDiff Configuration

This document lists every environment variable consumed by the self-hostable VizDiff deployment,
which service(s) read it, whether it is required, its default, and a short description.

VizDiff is a Yarn v4 monorepo with three runtime services:

- **api** — Express HTTP API (auth, projects, uploads, webhooks). Sole database schema owner.
- **worker** — renders Storybook builds and posts GitLab commit statuses.
- **frontend** — Next.js static export. `NEXT_PUBLIC_*` variables are **build-time** only.

## VCS platforms

VizDiff is self-hosted only and integrates with two VCS platforms—enable either or both:

- **GitLab** (default) — projects, merge-request commit statuses, and webhooks via a configured
  service token per host (see [GitLab service tokens](#gitlab-service-tokens-gitlab_hosts)). On-prem
  GitLab and gitlab.com are supported simultaneously.
- **GitHub** (optional; set `GITHUB_ENABLED=true`) — projects and pull-request checks via a GitHub App.

User identity (login) is handled separately by the pluggable AuthProvider described below.

## Authentication

Identity is provided by a pluggable `AuthProvider`, selected by `AUTH_PROVIDER`:

- `oidc` (default in production) — generic OIDC / Microsoft Entra (MSAL) via `openid-client`.
  Uses PKCE and a signed-cookie state (no server-side session store), so the deployment stays
  stateless. The ID token's signature, issuer, audience, expiry, state, and nonce are validated
  against the discovered JWKS. Typical for GitLab-mode deployments.
- `github` — GitHub OAuth login (for GitHub-mode deployments). Authenticates with GitHub and links
  the user's GitHub account so the GitHub App integration works. Requires `GITHUB_CLIENT_ID` /
  `GITHUB_CLIENT_SECRET`; pair with `GITHUB_ENABLED=true`.
- `dev` — non-production fixed identity (`subject="dev"`, email `DEV_AUTH_EMAIL`). Refuses to run
  in production. Replaces the old `X-Test-User-Id` shortcut.
- `custom` — reserved slot for a future custom auth service. Implement the
  `AuthProvider` interface in `api/src/auth/` and wire it in `api/src/auth/index.ts`.

The existing JWT-cookie session mechanism is retained; only the identity source changed. After a
successful login the API issues the same `token` (8h) and `authenticated` (30d) cookies as before.

## Authorization

Any authenticated user can view and manage **all** projects. Per-user VCS-membership scoping has
been removed. The project creator is still recorded for audit (`projects.user_id`).

## GitLab service tokens (`GITLAB_HOSTS`)

GitLab API calls (commit statuses, project/group listing) use a configured **service token** per
host instead of each user's OAuth token. The token needs `api` scope and **Developer+** role.

`GITLAB_HOSTS` is a JSON array of objects:

```json
[
  { "host": "https://gitlab.com",            "token": "glpat-...", "rejectUnauthorized": true },
  { "host": "https://gitlab.corp.example.com","token": "glpat-...", "rejectUnauthorized": false,
    "webhookSecret": "per-host-secret" }
]
```

- `host` — the GitLab origin (scheme + host + port). Resolution is exact-origin match.
- `token` — service token with `api` scope.
- `rejectUnauthorized` — `false` for on-prem instances with self-signed certificates (a per-host
  `undici` Agent is used so gitlab.com stays strict).
- `webhookSecret` — optional; verifies the `X-Gitlab-Token` header for webhooks from this host.
  Falls back to the global `GITLAB_WEBHOOK_SECRET` when unset.

Single-host fallback: when `GITLAB_HOSTS` is unset, a single host is derived from `GITLAB_HOST` +
`GITLAB_TOKEN` (+ optional `GITLAB_REJECT_UNAUTHORIZED` and `GITLAB_WEBHOOK_SECRET`).

## Environment variables

| Name | Service(s) | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | api, worker, frontend | no | `development` | `production` / `staging` / `test` / `development`. |
| `APP_URL` | api, worker | yes (prod) | `https://vizdiff.io` | Public base URL; used for cookies, redirects, and `build?id=` links. |
| `JWT_SECRET` | api | yes | `secret` | Signs the session JWT cookie and the transient OIDC state cookie. |
| `PORT` | api | no | `3001` | API listen port. |
| `WORKER_HEALTH_PORT` | worker | no | `3003` | Worker health endpoint port. |
| `CHROMEDRIVER_PORT` | worker | no | `4444` (in the image) | Port of an already-running chromedriver to connect to. The worker image's `start.sh` launches chromedriver on `4444` and sets this, so a containerized worker connects to it regardless of `NODE_ENV`. Leave unset for local `yarn dev`/`yarn screenshot` (WebdriverIO then manages its own driver). |
| `WORKER_STORY_CONCURRENCY` | worker | no | `1` | Number of stories rendered concurrently within a single ingest task (issue #152). Each unit is one independent headless-Chrome session in the per-ingest pool, so it is also the peak number of Chrome processes per in-flight build. Rendering runs in genuine parallel (no shared browser mutex), so raising this scales render throughput at a roughly linear cost in browser RAM. Defaults to `1` (one session) — the same browser-memory footprint as before. Raise it once the host has headroom for N× Chrome RSS. |
| `WORKER_CHANGED_MIN_PIXELS` | worker | no | `10` | Minimum number of differing pixels (post-pixelmatch) for a story's baseline comparison to be marked **changed**. An absolute pixel floor is size-independent — unlike a ratio, the same one-word text change flags on a button-sized story and a full-page story alike. Rendering is deterministic per worker image, so a handful of differing pixels is a real change; values below the floor tolerate stray single-pixel jitter. `0` means any differing pixel flags. Invalid values fall back to the default. |
| `WORKER_CHANGED_THRESHOLD` | worker | no | `0` | Minimum fraction of differing pixels (0–1) for a story to be marked **changed**, applied together with `WORKER_CHANGED_MIN_PIXELS` (both floors must be met). Defaults to `0` (no ratio floor); raise it as an escape hatch for deployments with nondeterministic stories where a fixed pixel count flags too often on large screenshots. Neither setting affects the capture-stabilization loop. Invalid or out-of-range values fall back to the default. |
| `WORKER_ENABLE_WEBGL` | worker | no | `false` | Opt-in software (SwiftShader) WebGL for story rendering (issue #447). Off by default because SwiftShader is in-process software rasterization driven by untrusted story content — a larger attack surface than no GL at all. Disabled → screenshot sessions launch with `--disable-webgl` and WebGL-dependent stories (maplibre-gl, deck.gl, three.js, …) fall into their error boundaries; enabled → sessions launch with `--enable-unsafe-swiftshader` and render WebGL deterministically on the CPU (same SwiftShader version → same pixels). |
| `WORKER_CHROME_EXTRA_ARGS` | worker | no | — | Whitespace-separated extra Chrome flags appended to the screenshot session launch args, after the hardening and WebGL flags (e.g. `--force-color-profile=srgb --lang=de`). Appending can only add flags, not remove the hardening set; use `WORKER_ENABLE_WEBGL` (not this) to control WebGL. |
| `WORKER_FATAL_FAILSAFE_TIMEOUT_MS` | worker | no | `5000` | Upper bound (ms) on the best-effort "mark the build failed + post the failed VCS status" work that runs just before the worker's fatal `process.exit` on a wedged render (issue #451). The exit is never delayed past this. |
| `WORKER_MAX_TASK_ATTEMPTS` | worker | no | `3` | Maximum number of times a task may be claimed before the startup orphan reclaim fails the build outright instead of requeueing it (issue #451). Bounds the crash loop where a build reliably wedges the worker. |
| `WORKER_STUCK_RUNNING_MINUTES` | worker | no | `15` | Stuck-build sweeper threshold for `running` builds (issue #451): a running build whose last activity (`COALESCE(last_progress_at, updated_at)`; `last_progress_at` is the story-completion heartbeat, issue #452) is older than the effective threshold is marked failed, its queue rows removed, and a failed VCS status posted. The effective threshold is `max(this, 3 × WORKER_PROGRESS_TIMEOUT_MS)`, so the cross-worker sweeper never fires faster than three in-process stall windows. |
| `WORKER_STUCK_PENDING_MINUTES` | worker | no | `240` | Stuck-build sweeper threshold for `pending` builds (issue #451): a pending build not updated for this many minutes is marked failed. Conservative because pending builds legitimately queue behind other work. |
| `WORKER_STORY_RENDER_TIMEOUT_MS` | worker | no | `30000` | Per-story render timeout (issue #458). After navigating to a story the worker waits for Storybook's story-render lifecycle to complete (a `storyRendered`/`docsRendered` channel event, or Storybook 8's `currentRender` phase reaching `completed`) before the visual-stability capture loop starts, so async/Suspense stories are not captured as loading spinners. A story that neither completes nor errors within this window is marked **failed**. See "Story readiness" below. |
| `WORKER_STORY_DELAY_MAX_MS` | worker | no | `15000` | Upper bound on a story's opt-in pre-capture delay (`parameters.vizdiff.delay` / `parameters.chromatic.delay`). Story parameters come from untrusted uploads, so larger requested delays are clamped to this cap to keep one story from stalling a build. |
| `WORKER_SESSION_RECYCLE_STORIES` | worker | no | `150` | Recycle (close + relaunch) each pooled Chrome session after it has rendered this many stories (issue #453). Chrome's memory grows cumulatively over long builds until the kernel OOM-kills it; periodic recycling bounds worst-case memory regardless of storybook size, at ~1–2 s per recycle. `0` disables recycling. See "Worker memory sizing" below. |
| `WORKER_SESSION_PROBE_TIMEOUT_MS` | worker | no | `5000` | Timeout for the cheap between-stories browser-session health probe (issue #450): a trivial script raced against this local timer. A dead session (e.g. Chrome OOM-killed mid-build) otherwise burns the webdriver package's hardcoded 60 s command timeout per command; the probe detects death within this window instead, and the worker replaces the session. |
| `WORKER_SESSION_MAX_INFRA_FAILURES` | worker | no | `2` | Treat a pooled session as dead after this many *consecutive* infrastructure-classified story failures (issue #450): the pool replaces it with a fresh Chrome session before handing it to the next render. `0` disables the threshold (probe-based replacement still applies). |
| `WORKER_STORY_MAX_ATTEMPTS` | worker | no | `2` | Maximum render attempts per story (issue #454). Only infrastructure-classified failures (dead session, command timeout, storage) are retried on a healthy session; story-classified failures (the story threw, or never became ready) are recorded immediately since retrying would just fail again. When the budget is exhausted the story is recorded as **failed** with its infra `errorKind`, so reviewers can distinguish "the harness failed" from "the story is broken". |
| `WORKER_FINALIZE_CONCURRENCY` | worker | no | `4` | Number of per-story finalize tasks — the S3 screenshot/diff uploads, baseline download, pixelmatch comparison, and TestResult row save that follow screenshot capture — processed concurrently in the background (issue #456). Capture releases its browser session before finalize starts, so this is decoupled from `WORKER_STORY_CONCURRENCY`; the default keeps a few uploads in flight without saturating the network or database. Values < 1 are clamped to 1. |
| `WORKER_FINALIZE_QUEUE_LIMIT` | worker | no | `16` | Upper bound on stories that have finished capture but are not yet finalized (issue #456). Each such story buffers one screenshot PNG in memory, so this caps the pipeline's extra memory footprint; when the backlog hits the limit, the next capture waits for a finalize to drain. Values < 1 are clamped to 1. |
| `WORKER_STABILIZE_INTERVAL_MS` | worker | no | `250` | Interval (ms) between consecutive screenshots in the visual-stabilization loop. **Default change (issue #456):** previously a hardcoded `500`. Since issue #458 capture already waits for Storybook's semantic render-completion signal before this loop starts, so it is a final settle check rather than the primary readiness gate. Raise it back toward `500` for storybooks with slow animations that need a longer window to register as still moving. Values < 1 are clamped to 1. |
| `WORKER_POST_LOAD_DELAY_MS` | worker | no | `250` | Fixed settle delay (ms) after the post-stabilization viewport resize (growing the viewport to fit tall content) before the final full-height screenshot (issue #456; previously this reused the 500 ms stabilization interval). The legacy fixed post-load pause before the *first* screenshot was superseded by the issue #458 readiness gate; the degraded-readiness fallback path keeps its own fixed delay. |
| `WORKER_PROGRESS_TIMEOUT_MS` | worker | no | `300000` (5 min) | Progress watchdog (issue #452): abort a build once **no story has completed** for this long. A build that is steadily completing stories is healthy no matter how large it is, while a wedged build is detected within minutes instead of at the whole-build ceiling. The aborted build is failed and treated as non-retryable. `0` disables the watchdog (only the ceiling then applies). |
| `WORKER_PER_STORY_BUDGET_MS` | worker | no | `5000` | Per-story render budget used to derive the whole-build timeout ceiling when `BUILD_TIMEOUT_MS` is unset: `ceiling = max(BUILD_TIMEOUT_FLOOR_MS, ceil(storyCount × budget / WORKER_STORY_CONCURRENCY))`. Deliberately generous versus the observed ~1.5–2 s happy-path story cost — the ceiling is a backstop; the progress watchdog is the primary stall detector. |
| `BUILD_TIMEOUT_MS` | worker | no | unset (derived) | Whole-build render timeout ceiling. Unset = derived from the discovered story count (issue #452, see `WORKER_PER_STORY_BUDGET_MS` / `BUILD_TIMEOUT_FLOOR_MS`), so a large-but-healthy storybook is never killed by a flat cap; an explicit value is used verbatim (back-compat with deployments that tuned the former flat cap). Applies to the render fan-out only — download, extraction, and story discovery run under their own bounded timeouts. A build exceeding the ceiling is failed and treated as non-retryable. |
| `BUILD_TIMEOUT_FLOOR_MS` | worker | no | `900000` (15 min) | Lower bound on the derived whole-build ceiling, so small storybooks keep the previous 15-minute allowance rather than getting a tiny ceiling. Ignored when `BUILD_TIMEOUT_MS` is set explicitly. |
| `BUILD_ABORT_GRACE_MS` | worker | no | `10000` | After the build watchdog (progress stall or ceiling) aborts the browser sessions, how long to wait for the in-flight render to actually unwind (running its `finally` blocks, returning sessions to the pool) before declaring it unrecoverable and exiting the worker so the orchestrator restarts a clean process. |
| `BUILD_MEMORY_WARN_BYTES` | worker | no | `2147483648` (2 GiB) | Resident set size past which a build logs a memory-pressure warning. Purely observational; it does not abort the build. |
| `POSTGRES_HOST` | api, worker | no | `localhost` | Postgres host. |
| `POSTGRES_PORT` | api, worker | no | `5432` | Postgres port. |
| `POSTGRES_USER` | api, worker | no | `postgres` | Postgres user. |
| `POSTGRES_PASS` | api, worker | no | `postgres` | Postgres password. |
| `POSTGRES_DATABASE` | api, worker | no | `vizdiff` | Postgres database name. |
| `S3_BUCKET_NAME` | api, worker | yes | `vizdiffio-testing` | Bucket for uploaded Storybook tarballs and screenshots. |
| `S3_ENDPOINT` | api, worker | no | — | Custom S3 endpoint for non-AWS object stores (e.g. `http://minio:9000` for the chart's standalone/air-gapped MinIO mode). Unset → real AWS S3. |
| `S3_FORCE_PATH_STYLE` | api, worker | no | `true` when `S3_ENDPOINT` set | Use path-style addressing (required by MinIO). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | api, worker | yes* | — | Standard AWS SDK credentials (omit when using IRSA / instance roles; for MinIO use its access/secret keys). |
| `ENABLE_VCS_STATUS` | api, worker | no | `true` in prod/staging | Whether to post VCS commit statuses. |
| `MAX_STORIES_PER_UPLOAD` | worker | no | `1000` | Max stories processed per upload; over-limit uploads fail the build. `0` disables. |
| `MAX_TARBALL_FILES` | worker | no | `50000` | Max number of file entries allowed in an uploaded tarball. `0` disables. |
| `MAX_EXTRACTED_BYTES` | worker | no | `1073741824` (1 GiB) | Max total uncompressed size of an extracted tarball (zip-bomb guard). `0` disables. |
| `MAX_TARBALL_ENTRY_BYTES` | worker | no | `268435456` (256 MiB) | Max size of any single extracted file. `0` disables. |
| `MAX_TARBALL_PATH_LENGTH` | worker | no | `4096` | Max length of any path inside the tarball. `0` disables. |
| `MAX_STORY_IDENTIFIER_LENGTH` | worker | no | `2048` | Max length of a story id/name/title/importPath. `0` disables. |
| `AUTH_PROVIDER` | api | no | `oidc` (prod), `dev` (else) | Identity provider: `oidc`, `github`, or `dev`. |
| `OIDC_ISSUER` | api | yes (oidc) | — | OIDC issuer URL (e.g. `https://login.microsoftonline.com/<tenant>/v2.0`). |
| `OIDC_CLIENT_ID` | api | yes (oidc) | — | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | api | yes (confidential clients) | — | OIDC client secret. |
| `OIDC_REDIRECT_URI` | api | no | `${APP_URL}/api/auth/callback` | OIDC redirect/callback URI. |
| `OIDC_SCOPES` | api | no | `openid profile email` | Space-separated OIDC scopes. |
| `OIDC_REJECT_UNAUTHORIZED` | api | no | `true` | Set `false` for self-signed IdPs (dev/test only). |
| `DEV_AUTH_EMAIL` | api | no | `dev@vizdiff.local` | Email for the `dev` auth provider's fixed identity. |
| `GITLAB_HOSTS` | api, worker | yes (GitLab) | — | JSON array of per-host service-token configs (see above). |
| `GITLAB_HOST` | api, worker | no | `https://gitlab.com` | Default host for token resolution and single-host fallback. |
| `GITLAB_TOKEN` | api, worker | no | — | Single-host service token (fallback when `GITLAB_HOSTS` unset). |
| `GITLAB_REJECT_UNAUTHORIZED` | api, worker | no | `true` | Single-host TLS verification (fallback). |
| `GITLAB_WEBHOOK_SECRET` | api | no | — | Global GitLab webhook secret (per-host `webhookSecret` takes precedence). |
| `GITHUB_ENABLED` | api, worker | no | `false` | Enables GitHub routes, webhooks, and uploads. |
| `GITHUB_APP_ID` | api, worker | yes (GitHub) | — | GitHub App ID. |
| `GITHUB_CLIENT_ID` | api, worker | yes (GitHub) | — | GitHub App client ID. |
| `GITHUB_CLIENT_SECRET` | api, worker | yes (GitHub) | — | GitHub App client secret. |
| `GITHUB_PRIVATE_KEY` | api, worker | yes (GitHub) | — | GitHub App private key (PEM). |
| `GITHUB_WEBHOOK_SECRET` | api | yes (GitHub) | — | GitHub webhook signing secret. |
| `NEXT_PUBLIC_APP_URL` | frontend | no | `https://vizdiff.io` | Public base URL (build-time). |
| `NEXT_PUBLIC_GITHUB_ENABLED` | frontend | no | `false` | Shows the GitHub create-project UI (build-time). |
| `NEXT_PUBLIC_GITHUB_APP_NAME` | frontend | no | — | GitHub App slug for the "Install App" link (build-time). |
| `NEXT_PUBLIC_GITHUB_CLIENT_ID` | frontend | no | — | GitHub OAuth client ID (build-time, GitHub only). |
| `RETENTION_REAPER_ENABLED` | worker | no | `false` | Enables the screenshot retention reaper (see below). Destructive — opt-in. |
| `RETENTION_DAYS` | worker | no | `90` | Builds older than this many days are eligible for deletion. |
| `RETENTION_KEEP_LAST_N` | worker | no | `10` | Always retain at least this many most-recent builds per project, regardless of age. |
| `RETENTION_MAX_BUILDS_PER_SWEEP` | worker | no | `200` | Upper bound on builds reaped per sweep. |
| `RETENTION_SWEEP_INTERVAL_MS` | worker | no | `3600000` | Minimum interval between sweeps (min 60000). |

\* Credentials may be supplied via IRSA, instance profiles, or the standard AWS credential chain
instead of static keys.

### Worker memory sizing

Size the worker's container memory limit against `WORKER_STORY_CONCURRENCY`: budget the worker's
base footprint plus roughly **1–1.5 GiB per concurrent Chrome session** (more when
`WORKER_ENABLE_WEBGL` is on, since SwiftShader rasterizes in-process). Chrome's memory grows
cumulatively over long builds — a 700+-story build under a 2 GiB limit was OOM-killed around story
150–200 (issue #453) — so `WORKER_SESSION_RECYCLE_STORIES` (default 150) periodically relaunches
each session to bound worst-case growth regardless of storybook size. If Chrome is still
OOM-killed mid-build, raise the container limit or lower the recycle interval; a killed session is
detected by the health probe and replaced, with affected stories retried (issues #450/#454).

## Worker metrics

The worker serves Prometheus metrics at `GET /metrics` on the health port (`WORKER_HEALTH_PORT`,
default `3003`), next to the existing `/health` endpoint (issue #457). Metrics are always enabled —
there is no env var to turn them on or off. Node.js process/runtime metrics are also exported with
the `vizdiff_worker_` prefix.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `vizdiff_worker_builds_total` | counter | `outcome` = `completed` \| `failed` \| `aborted` | Builds processed. `aborted` means the build watchdog fired (progress stall or whole-build ceiling, issue #452). |
| `vizdiff_worker_build_duration_seconds` | histogram | — | Wall-clock build ingestion duration (download through render/finalize). |
| `vizdiff_worker_stories_total` | counter | `outcome` = `ok` \| `infra_error` \| `story_error` | Stories processed. A spike in `infra_error` (dead browser session, command timeout, storage) is the wedged-session signature. |
| `vizdiff_worker_story_duration_seconds` | histogram | `phase` = `capture` \| `finalize` | Per-story phase duration. `capture` p95 pinned at the 60 s command timeout means the browser is dead. |
| `vizdiff_worker_browser_relaunches_total` | counter | — | Pooled Chrome sessions replaced (dead-session probe, consecutive infra failures, or periodic recycling; issues #450/#453). |
| `vizdiff_worker_queue_depth` | gauge | — | Claimable tasks in `task_queue` (unlocked, or lock expired). Sampled at scrape time with a 2 s query timeout; serves the last-known value if the database is slow. |
| `vizdiff_worker_last_story_completed_timestamp` | gauge | — | Unix time (seconds) of the last observed story progress. |

The worker's `/health` endpoint also reports `status: "ok" | "degraded"` (plus a `degradedReason`
and a build-progress snapshot) in its JSON body. It intentionally stays HTTP 200 while degraded:
the Kubernetes liveness probe uses `/health/live`, and restarting the pod is the wrong response to
a stalled build — the in-process progress watchdog (`WORKER_PROGRESS_TIMEOUT_MS`, issue #452)
aborts the stall with proper build-failure bookkeeping. `degraded` means a build is active but no
story has made progress for longer than the watchdog window.

To scrape with an annotation-based Prometheus setup, add pod annotations (see `podAnnotations` in
the Helm chart's `values.yaml`):

```yaml
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3003"
  prometheus.io/path: "/metrics"
```

Example alert rules:

```yaml
groups:
  - name: vizdiff-worker
    rules:
      # Wedged-session signature: infra-classified story failures spiking.
      - alert: VizdiffWorkerInfraErrors
        expr: sum(rate(vizdiff_worker_stories_total{outcome="infra_error"}[10m])) > 0.1
        for: 10m
        annotations:
          summary: "vizdiff worker is recording infra-classified story failures"

      # No story has completed for 5 minutes while stories were recently flowing. The gauge
      # persists across idle gaps, so the `and` clause ("stories were completing within the last
      # 15 minutes") keeps a long-idle worker from paging; cross-check the /health JSON
      # (`status: "degraded"`) to confirm a build is actually active.
      - alert: VizdiffWorkerBuildStalled
        expr: >
          (time() - vizdiff_worker_last_story_completed_timestamp > 300)
          and (increase(vizdiff_worker_stories_total[15m]) > 0)
        annotations:
          summary: "vizdiff worker build has made no progress for 5+ minutes"

      # Crash loop (the issue #457 incident: 44 restarts over 14 h), via kube-state-metrics.
      - alert: VizdiffWorkerCrashLooping
        expr: >
          increase(kube_pod_container_status_restarts_total{container="worker"}[1h]) > 3
        annotations:
          summary: "vizdiff worker container is restarting repeatedly"
```

## Story readiness

The worker captures a story only after Storybook reports its render lifecycle complete
(`storyRendered`/`docsRendered`, or the Storybook 8 `currentRender` phase reaching `completed`),
bounded by `WORKER_STORY_RENDER_TIMEOUT_MS`; a story that errors or never completes is marked
**failed** instead of screenshotting its loading fallback. Two per-story opt-ins refine this:

- **Pre-capture delay** — `parameters.vizdiff.delay` (preferred) or the Chromatic-compatible
  `parameters.chromatic.delay`, in milliseconds, adds a minimum pause after render completion
  before capture (for settle animations, font swaps, etc.). `vizdiff.delay` takes precedence when
  both are set, and the effective delay is clamped to `WORKER_STORY_DELAY_MAX_MS`.
- **Explicit ready signal** — stories that finish drawing asynchronously (WebGL scenes, async
  loaders) can set `parameters.useReadySignal: true` (the Chromatic-era Foxglove convention; also
  honored as `parameters.vizdiff.waitForReady` or `parameters.storyReady`). The worker then also
  waits for `window.__VIZDIFF_STORY_READY__ === true` before capturing, within the same per-story
  timeout budget.

For Chromatic-era `useReadySignal` storybooks, bridge the existing ready promise with a preview
decorator that resets the global per story and sets it when the story's signal resolves:

```ts
// .storybook/preview.ts — bridge a story's readySignal to vizdiff
decorators: [
  (Story, { parameters }) => {
    ;(window as any).__VIZDIFF_STORY_READY__ = false
    if (parameters.useReadySignal) {
      readySignalPromise.then(() => ((window as any).__VIZDIFF_STORY_READY__ = true))
    } else {
      ;(window as any).__VIZDIFF_STORY_READY__ = true
    }
    return Story()
  },
]
```

## Screenshot retention reaper

When `RETENTION_REAPER_ENABLED=true`, the worker periodically deletes screenshot builds whose newest
activity is older than `RETENTION_DAYS`, **while always keeping the most recent
`RETENTION_KEEP_LAST_N` builds per project** so a rarely-built project never loses its history. The
keep-last-N guard is applied before the age filter. Deletion removes the build's S3 objects
(screenshots prefix and uploaded tarball; key layout in `shared/src/s3Keys.ts`) first, then the
`screenshot_tests` row (its `test_results`
and `task_queue` rows cascade via foreign keys). In-flight builds (`pending`/`running`) are never
reaped. The reaper runs on the worker's idle tick (throttled to `RETENTION_SWEEP_INTERVAL_MS`) and is
idempotent, so partial failures are safely retried. It is disabled by default because it permanently
deletes data.

## Database migrations

The API is the sole schema owner. It runs with `synchronize: false` and applies TypeORM migrations
from `dist/migrations/*.js` on boot (`migrationsRun: true`). The worker uses `synchronize: false`
and never alters the schema.

Migration scripts (run from the repo root):

```bash
yarn api migration:generate api/src/migrations/<Name>   # generate from the entity diff
yarn api migration:run                                   # apply pending migrations
yarn api migration:revert                                # revert the last migration
```

Generating migrations requires a reachable Postgres (`docker compose up -d postgres`). The CLI uses
the datasource at `api/src/datasource.ts`.

### Projects uniqueness and monorepo support

Projects are unique on `(vcs_provider, repo_id, gitlab_host, key)`. The `key` column is an
optional monorepo discriminator (default `''`), so one repository can host **multiple** VizDiff
projects — one per Storybook — as long as each has a distinct key (issue #443):

- Creating a second project for a repo **without** a key is still rejected (HTTP 409), preserving
  the old accidental-duplicate safety net for single-project repos.
- Pass `key` when creating a project (`POST /api/projects`, or the "Project key" field in the
  Add Repository dialog). Keys are 1-64 chars: letters, digits, dots, underscores, dashes.
- Each project reports its own GitLab commit status context: `vizdiff/visual-tests` for the
  default (empty-key) project, `vizdiff/visual-tests/<key>` otherwise — so several Storybooks in
  one MR get independent pass/fail statuses. GitHub check runs are similarly named
  `Visual Tests` / `Visual Tests (<key>)`.
- Uploads are always identified by the per-project upload token, and webhooks fan out to every
  project registered for the repository, so no extra CI/webhook configuration is needed per key.

An earlier self-host migration re-keyed the `projects` unique index from
`(user_id, vcs_provider, repo_id)` to `(vcs_provider, repo_id, gitlab_host)`. If multiple users
previously created VizDiff projects for the same repo, that unique index creation will **fail**
until duplicates are removed. De-duplicate before/with the migration, e.g.:

```sql
-- Inspect duplicates
SELECT vcs_provider, repo_id, gitlab_host, count(*)
FROM projects GROUP BY 1,2,3 HAVING count(*) > 1;
-- Keep the lowest id per group, delete the rest (review first!)
DELETE FROM projects p USING projects q
WHERE p.vcs_provider = q.vcs_provider AND p.repo_id = q.repo_id
  AND p.gitlab_host IS NOT DISTINCT FROM q.gitlab_host AND p.id > q.id;
```

(The later `AddProjectKey` migration widens the index to include `key`, enabling the monorepo
setup above.)

### Schema naming conventions

Columns are `snake_case` with one **legacy exception**: `test_results."diffRatio"` is camelCase. The
application accesses it through the TypeORM entity so app code is unaffected, but raw SQL must quote
it exactly — `SELECT "diffRatio" FROM test_results` (an unquoted `diff_ratio` does not exist and
will error). See `shared/src/entity/TestResult.ts`.

## Private S3 / presigned URLs

Bring your own S3 (or S3-compatible store). The bucket is **private**; the worker stores each
screenshot's S3 object key, and URLs are generated as presigned GET URLs at read time:

- **Interactive build viewer** (`GET /api/builds/:id`): presigned with `IMAGE_URL_TTL_SECONDS` (short).
- **PR/MR comment images** (markdown posted to GitHub/GitLab): presigned with `VCS_IMAGE_URL_TTL_SECONDS`
  (long). See `api/src/s3.ts` / `worker/src/s3.ts`.

Caveats:

- **7-day cap on comment images.** S3 SigV4 presigned URLs expire after at most 7 days, so screenshots
  embedded in older PR/MR comments will stop loading. The build still renders fresh URLs in the web UI.
  For permanent comment images, front the bucket with an authenticated proxy or CloudFront-with-OAC.
- **MinIO / S3-compatible mode.** Presigned URLs point at `S3_ENDPOINT`; that host must be reachable
  from the user's browser (not just from inside the cluster) for images to load.
- **Legacy rows.** Rows that stored a full public S3 URL (pre-migration) are handled transparently—the
  presigner extracts the object key from the URL path.
- **EC2 instance role (no static keys).** If you omit `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` and
  rely on the instance's IAM role, the SDK fetches credentials from IMDSv2. A container is one extra
  network hop from the instance, so the instance metadata **hop limit must be ≥ 2** (the default is 1)
  or every S3 call fails with a credentials error. Set it once per instance:
  ```bash
  aws ec2 modify-instance-metadata-options --instance-id <id> \
    --http-put-response-hop-limit 2 --http-tokens required
  ```
