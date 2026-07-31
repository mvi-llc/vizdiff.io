# Scale testing (cross-worker sharding)

End-to-end verification that a large build shards across multiple worker replicas and converges
(issue #456, Phase B). The harness has two parts:

- `docker-compose.scale.yml` — a test-rig override for `docker-compose.images.yml` that runs
  **two** worker replicas (`worker` + `worker2`) with `WORKER_STORY_CONCURRENCY=4` each, and
  bundles a throwaway MinIO (plus bucket-creation job) so no external S3 is needed. It overrides
  the stack's `S3_*` settings for the duration of the test.
- `scripts/e2e-scale.mjs` — generates a synthetic N-story static storybook, uploads it, polls the
  api until the build is terminal, and asserts the result count, terminal status, and wall clock.
  `--kill-worker` adds a mid-build worker-crash drill.

In addition to `--stories N` plain stories, every generated fixture includes (issue #473; each
knob accepts `0` to disable):

- One **web-worker-backed story** (`--worker-stories`, default 1): the page spawns a dedicated
  `Worker` whose script `fetch()`es a same-origin binary and postMessages back; the story only
  signals readiness (`parameters.useReadySignal`) from that `onmessage`.
- Two **font-loading story pairs** (`--font-stories`, default 2; each pair is a light+dark story
  id, so N pairs add 2N stories): even pairs load a real same-origin woff2 via page-scope
  `FontFace` + `document.fonts`, odd pairs load it from a dedicated worker's scope (`self.fonts`
  + OffscreenCanvas text draw). Readiness is gated on the font load **settling** — the #473
  production wedge left same-origin font fetches paused forever, so a regression shows up as
  `ready-signal-timeout` with the woff2 pending in the story's failure diagnostics. Each story
  id busts the font cache with its own query param; the fixture `<head>` also requests the font
  at document-boot time (CSS `@font-face` + preload) and every story kicks off a non-gating
  "ambient" font load, mirroring production font traffic in flight across story switches.
- One **egress-canary story** (`--canary-stories`, default 1): a dedicated worker (outside the
  page init-script guard, so only the network-layer egress control applies) fetches
  `http://example.com/` and an IP-literal URL; the story only signals readiness if the hostname
  fetch is BLOCKED fast. An open egress path — or a block that wedges the request instead of
  failing it — fails the story.

All assertions run against the total (`--stories` + `--worker-stories` + 2 × `--font-stories` +
`--canary-stories`).

The fixture also exposes a minimal Storybook preview channel so the worker's in-place story
switching (issue #474) is exercised by default; pass `--legacy-fixture` to generate the pre-#474
channel-less HTML instead, which forces the worker down the hard-navigation fallback path on
every story (useful for comparing the two navigation modes on the same stack).

Requirements: Docker + the compose plugin, `tar`, Node >= 20. Everything below runs from the
repo root.

## 1. Build (or pull) the images

The scale override runs the same GHCR images as `docker-compose.images.yml`
(`VIZDIFF_VERSION` selects the tag). To test a local checkout instead, build from source and tag
the results as the image names the compose file expects:

```sh
docker compose -f docker-compose.yml build api worker
# docker compose build names images <project>-api / <project>-worker, where <project> defaults
# to the repo directory name (check `docker images`). Retag them for the images compose file:
proj=$(basename "$PWD")
docker tag "${proj}-api" ghcr.io/vizdiff-io/vizdiff-api:e2e
docker tag "${proj}-worker" ghcr.io/vizdiff-io/vizdiff-worker:e2e
export VIZDIFF_VERSION=e2e
```

(The frontend is not needed by the harness.)

## 2. Configure and start the stack

A minimal `.env` (see `.env.example`; MinIO from the override replaces the S3 settings):

```sh
cat > .env <<EOF
APP_URL=http://localhost
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_USER=vizdiff
POSTGRES_PASS=vizdiff_password
POSTGRES_DATABASE=vizdiff
POSTGRES_PORT=5432
AWS_ACCESS_KEY_ID=unused
AWS_SECRET_ACCESS_KEY=unused
AWS_REGION=us-east-1
S3_BUCKET_NAME=unused
EOF
```

Then:

```sh
docker compose -f docker-compose.images.yml -f docker-compose.scale.yml up -d \
  postgres minio minio-init api worker worker2
```

Wait for `docker compose -f docker-compose.images.yml -f docker-compose.scale.yml ps` to show
the api and both workers healthy.

## 3. Create a project + token

Two options:

- **Let the script do it** (default): with no `--token`, `scripts/e2e-scale.mjs` creates an
  `e2e-scale-harness` user + project directly in the stack's Postgres via
  `docker compose exec postgres psql` (idempotent; re-runs rotate the token).
- **Manually / against an existing deployment**: create a project in the UI (or API) and pass its
  upload token via `--token <token>` (plus `--user-id <id>` of any existing user for the polling
  session, and optionally `--project-id`). The script also needs the api's `JWT_SECRET`
  (`--jwt-secret`, `$JWT_SECRET`, or the repo-root `.env`) to mint a session JWT for the
  read-side polling endpoints.

## 4. Run the harness

```sh
# Inline (unsharded) path: below WORKER_SHARD_MIN_STORIES (default 100) the discovery task
# renders everything itself on one worker.
node scripts/e2e-scale.mjs --stories 60 --budget-seconds 600

# Sharded path: 150 stories -> 3 render_story_chunk tasks (WORKER_SHARD_CHUNK_SIZE=50) spread
# across both workers.
node scripts/e2e-scale.mjs --stories 150 --budget-seconds 600

# Full-scale run (default 743 stories -> 15 chunks).
node scripts/e2e-scale.mjs
```

Expected output: progress lines (`status=running results=250/743 ...`) followed by a result
block and `PASS: all assertions held.` The script exits non-zero if the terminal status is not
`no_changes`/`unapproved`, the result count differs from `--stories`, any story failed, or the
wall clock exceeds `--budget-seconds` (default 300).

A fresh project has no baseline, so every story reports `new` and the terminal status is
`unapproved`. Uploading again with the same project converges the same way (previous same-branch
results are cleaned up per commit).

Reference numbers from this rig (2 workers x `WORKER_STORY_CONCURRENCY=4`, local MinIO, WSL2
host): 60 stories (inline) ~10 s; 150 stories (3 chunks) ~15 s; 743 stories (15 chunks) ~45 s
upload-to-terminal; kill-worker drill on 150 stories ~10.5 min (dominated by the 10-minute
`WORKER_TASK_LOCK_TIMEOUT_MINUTES` before the orphaned chunk is reclaimed).

### Reproducing the #473 egress-interception wedge

The scale compose file passes `WORKER_ENABLE_WEBGL`, `WORKER_STORY_RENDER_TIMEOUT_MS`, and
`WORKER_EGRESS_BLOCK_MODE` through from the host environment. The interception wedge
(`'Fetch.continueRequest' wasn't found` → request paused forever → `ready-signal-timeout`) is a
load-dependent race on requests owned by dedicated-worker targets; it reproduces with the legacy
`intercept` mode under CPU contention and hard-navigation churn:

```sh
export WORKER_ENABLE_WEBGL=true WORKER_STORY_RENDER_TIMEOUT_MS=15000 \
       WORKER_EGRESS_BLOCK_MODE=intercept
# restart the workers so the env applies, then:
node scripts/e2e-scale.mjs --stories 200 --font-stories 24 --worker-stories 24 \
  --canary-stories 4 --legacy-fixture --budget-seconds 900
```

On a many-core host, also cap the worker containers' CPUs (e.g. `cpus: 2.0` in a local compose
override) to mirror production pod sizing — without contention the race window closes. Expect a
handful of worker-backed/canary stories to fail `ready-signal-timeout` with the same-origin
request pending in their failure diagnostics (`test_results.diagnostics->'pendingRequests'`).
The same run with `WORKER_EGRESS_BLOCK_MODE=resolver` (the default) passes with every canary
reporting the off-origin probe blocked.

## 5. The kill-worker drill

```sh
node scripts/e2e-scale.mjs --stories 150 --budget-seconds 1800 --kill-worker
```

After the upload, the script watches `task_queue` for a claimed `render_story_chunk` task and
`docker kill`s (SIGKILL — no graceful shutdown, no lock release) the worker container holding
it, then keeps polling. This exercises the crash-recovery path: the surviving worker keeps
rendering its chunks; the killed worker's lock stops heartbeating (locks are re-touched every
60 s while a task runs) and expires after `WORKER_TASK_LOCK_TIMEOUT_MINUTES` (default 10), at
which point the surviving worker reclaims the chunk and the build converges to a terminal
status with **all** N results — comfortably before the stuck-build sweeper
(`WORKER_STUCK_RUNNING_MINUTES`, default 15 min without build progress) would fail the build.
The sweeper remains the backstop ensuring no build row is left `running` indefinitely; the
script warns loudly if a build outlives that threshold. Budget the drill for the lock expiry
plus render time (`--budget-seconds 1800` is comfortable). A graceful stop (`docker stop`,
SIGTERM) releases the lock immediately and the build completes without waiting out the expiry.

Afterwards, bring the killed worker back:

```sh
docker compose -f docker-compose.images.yml -f docker-compose.scale.yml up -d
```

## 6. Teardown

```sh
docker compose -f docker-compose.images.yml -f docker-compose.scale.yml down -v
```

(`-v` also drops the Postgres and MinIO volumes.)
