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

## 5. The kill-worker drill

```sh
node scripts/e2e-scale.mjs --stories 150 --budget-seconds 1800 --kill-worker
```

After the upload, the script watches `task_queue` for a claimed `render_story_chunk` task and
`docker kill`s (SIGKILL — no graceful shutdown, no lock release) the worker container holding
it, then keeps polling. This exercises the crash-recovery path: the surviving worker keeps
rendering its chunks, and the killed worker's chunk must be recovered via the task-lock expiry /
attempts machinery before the build can converge; the stuck-build sweeper
(`WORKER_STUCK_RUNNING_MINUTES`, default 15 min without progress) is the backstop that ensures
no build row is left `running` indefinitely — the script warns loudly if a build outlives that
threshold.

Note the timing interaction the drill makes observable: a chunk task's claim lock only expires
after 60 minutes (`LOCK_TIMEOUT_MINUTES` in `worker/src/tasks.ts`), while the sweeper fails a
progress-less build after ~15 minutes — so a SIGKILL'd chunk is expected to end the drill with
the build swept to `failed` (a terminal state, CI unblocked) rather than completing with full
results. A graceful stop (`docker stop`, SIGTERM) releases the lock immediately and the build
completes normally. The drill's assertions are strict (terminal in `{no_changes, unapproved}`
with N results), so a sweeper-failed build reports as an assertion failure with a diagnostic —
by design, to keep the gap visible.

Afterwards, bring the killed worker back:

```sh
docker compose -f docker-compose.images.yml -f docker-compose.scale.yml up -d
```

## 6. Teardown

```sh
docker compose -f docker-compose.images.yml -f docker-compose.scale.yml down -v
```

(`-v` also drops the Postgres and MinIO volumes.)
