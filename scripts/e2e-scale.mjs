#!/usr/bin/env node
/**
 * End-to-end scale verification harness for cross-worker build sharding (issue #456).
 *
 * Generates a synthetic static Storybook fixture with N deterministic stories, uploads it to a
 * running vizdiff stack (see docker-compose.scale.yml for the 2-worker test rig), polls until
 * the build reaches a terminal status, and asserts:
 *
 *   - the terminal status is `no_changes` or `unapproved`,
 *   - the build has exactly N test results,
 *   - wall clock (upload -> terminal) stayed under --budget-seconds.
 *
 * With --kill-worker it additionally `docker kill`s the worker container that holds a claimed
 * render_story_chunk task mid-build, then applies the same assertions — verifying the build
 * still converges and that no build row is left `running` beyond the stuck-build sweeper
 * threshold.
 *
 * No npm dependencies: node:http for the API, `tar` for the fixture tarball, and
 * `docker compose exec postgres psql` for the optional bootstrap/kill-drill DB peeks.
 *
 * See docs/SCALE-TESTING.md for the full walkthrough.
 */

import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const TERMINAL_STATUSES = new Set(["no_changes", "unapproved", "approved", "denied", "failed"])
const PASSING_STATUSES = new Set(["no_changes", "unapproved"])
/** Default WORKER_STUCK_RUNNING_MINUTES (see worker/src/environment.ts). */
const SWEEPER_THRESHOLD_SEC = 15 * 60

const HELP = `Usage: node scripts/e2e-scale.mjs [options]

Uploads a synthetic N-story static storybook to a running vizdiff stack and verifies the build
completes with N results within a time budget. See docs/SCALE-TESTING.md.

Options:
  --stories N           Number of plain synthetic stories to generate (default: 743)
  --worker-stories N    Number of additional web-worker-backed stories (default: 1). Each spawns
                        a dedicated Worker that fetches a same-origin binary and only signals
                        readiness (parameters.useReadySignal) from the worker's onmessage —
                        exercising worker-owned network requests end to end (issue #473)
  --budget-seconds S    Fail if the build is not terminal within S seconds (default: 300;
                        use >= 1800 with --kill-worker so the recovery path has time to act)
  --api-url URL         Base URL of the vizdiff api (default: http://localhost:3001)
  --token TOKEN         Project upload token. Omit to bootstrap a user+project directly in the
                        stack's Postgres via docker compose (requires --compose-files access)
  --project-id ID       Project id for --token mode (omit to resolve it via GET /api/projects)
  --user-id ID          User id to mint the polling session JWT for (default: bootstrap user,
                        or 1 in --token mode)
  --jwt-secret SECRET   Session-signing secret for the polling JWT (default: JWT_SECRET from
                        the environment or the repo-root .env)
  --compose-files LIST  Comma-separated compose files for docker compose exec/ps, relative to
                        the repo root (default: docker-compose.images.yml,docker-compose.scale.yml)
  --kill-worker         docker kill the worker holding a claimed render_story_chunk task
                        mid-build, then assert the build still converges
  --legacy-fixture      Generate the pre-#474 channel-less fixture HTML: no
                        __STORYBOOK_ADDONS_CHANNEL__, so the worker cannot switch stories
                        in-place and hard-navigates every story (fallback-ladder path)
  --poll-interval S     Seconds between polls (default: 5)
  --keep-fixture        Keep the generated fixture/tarball temp dir for inspection
  --help                Show this help

Exit codes: 0 = all assertions passed, 1 = assertion failure, 2 = usage/environment error.`

// --- small utils --------------------------------------------------------------------------------

function log(msg) {
  const stamp = new Date().toISOString().slice(11, 19)
  console.log(`[${stamp}] ${msg}`)
}

function fail(msg, code = 1) {
  console.error(`\nFAIL: ${msg}`)
  process.exit(code)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const opts = {
    stories: 743,
    workerStories: 1,
    budgetSeconds: 300,
    apiUrl: "http://localhost:3001",
    token: undefined,
    projectId: undefined,
    userId: undefined,
    jwtSecret: undefined,
    composeFiles: ["docker-compose.images.yml", "docker-compose.scale.yml"],
    killWorker: false,
    legacyFixture: false,
    pollIntervalSeconds: 5,
    keepFixture: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v == undefined) fail(`Missing value for ${arg}`, 2)
      return v
    }
    switch (arg) {
      case "--stories":
        opts.stories = parseInt(next(), 10)
        break
      case "--worker-stories":
        opts.workerStories = parseInt(next(), 10)
        break
      case "--budget-seconds":
        opts.budgetSeconds = parseInt(next(), 10)
        break
      case "--api-url":
        opts.apiUrl = next().replace(/\/+$/, "")
        break
      case "--token":
        opts.token = next()
        break
      case "--project-id":
        opts.projectId = parseInt(next(), 10)
        break
      case "--user-id":
        opts.userId = parseInt(next(), 10)
        break
      case "--jwt-secret":
        opts.jwtSecret = next()
        break
      case "--compose-files":
        opts.composeFiles = next()
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
        break
      case "--kill-worker":
        opts.killWorker = true
        break
      case "--legacy-fixture":
        opts.legacyFixture = true
        break
      case "--poll-interval":
        opts.pollIntervalSeconds = Math.max(1, parseInt(next(), 10) || 5)
        break
      case "--keep-fixture":
        opts.keepFixture = true
        break
      case "--help":
      case "-h":
        console.log(HELP)
        process.exit(0)
        break
      default:
        fail(`Unknown option: ${arg}\n\n${HELP}`, 2)
    }
  }
  if (!Number.isInteger(opts.stories) || opts.stories < 1) {
    fail("--stories must be a positive integer", 2)
  }
  if (!Number.isInteger(opts.workerStories) || opts.workerStories < 0) {
    fail("--worker-stories must be a non-negative integer", 2)
  }
  if (!Number.isInteger(opts.budgetSeconds) || opts.budgetSeconds < 1) {
    fail("--budget-seconds must be a positive integer", 2)
  }
  return opts
}

/** Minimal .env parser (KEY=VALUE lines; no interpolation) for JWT_SECRET / POSTGRES_* lookups. */
function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, ".env")
  const result = {}
  if (!fs.existsSync(envPath)) return result
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2]
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

// --- HTTP helpers (node:http; fetch would fight us over Content-Length on the upload) -----------

function httpRequest(urlString, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(urlString)
  const mod = url.protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method, headers: body ? { ...headers, "Content-Length": body.length } : headers },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        })
      },
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

async function apiJson(urlString, options = {}) {
  const res = await httpRequest(urlString, options)
  let parsed
  try {
    parsed = JSON.parse(res.body)
  } catch {
    throw new Error(
      `Non-JSON response (HTTP ${res.status}) from ${urlString}: ${res.body.slice(0, 300)}`,
    )
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${urlString}: ${res.body.slice(0, 300)}`)
  }
  return parsed
}

/** Mint an HS256 session JWT the api's authenticateJWT accepts (same claims as auth.ts). */
function mintSessionJwt(userId, secret) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")
  const nowSec = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: "HS256", typ: "JWT" })
  const payload = b64url({ sub: String(userId), iat: nowSec, exp: nowSec + 8 * 60 * 60 })
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url")
  return `${header}.${payload}.${signature}`
}

// --- docker compose helpers ---------------------------------------------------------------------

function composeArgs(opts, ...rest) {
  return ["compose", ...opts.composeFiles.flatMap((f) => ["-f", f]), ...rest]
}

function dockerExec(args, { input } = {}) {
  return execFileSync("docker", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  })
}

function psql(opts, sql) {
  const dotEnv = loadDotEnv()
  const pgUser = process.env.POSTGRES_USER ?? dotEnv.POSTGRES_USER ?? "postgres"
  const pgDb = process.env.POSTGRES_DATABASE ?? dotEnv.POSTGRES_DATABASE ?? "vizdiff"
  return dockerExec(
    composeArgs(
      opts,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      pgUser,
      "-d",
      pgDb,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-At",
      "-F",
      "|",
    ),
    { input: sql },
  ).trim()
}

// --- fixture generation -------------------------------------------------------------------------

/**
 * Generates a static storybook fixture that satisfies everything the worker needs (see
 * worker/src/stories.ts + storyReady.ts): `iframe.html` at the tarball ROOT defining
 * `window.__STORYBOOK_PREVIEW__` with an awaitable `storyStore.cacheAllCSFFiles()`, an
 * `extract()` resolving to N story objects, and — when loaded as `iframe.html?id=<storyId>` — a
 * deterministic colored div for that story plus `currentRender.phase = "completed"` as the
 * render-readiness signal. No React, no bundler: readiness is instant, so the harness measures
 * pipeline overhead rather than app render time.
 *
 * In addition to `storyCount` plain stories the fixture always includes `workerStoryCount`
 * web-worker-backed stories (issue #473): each spawns a dedicated `Worker("worker-fixture.js")`
 * whose script `fetch()`es the same-origin `worker-data.bin` and postMessages the result; the
 * page only sets `window.__VIZDIFF_STORY_READY__ = true` in `onmessage`, and the story declares
 * `parameters: { useReadySignal: true }`. Readiness therefore depends on requests OWNED BY A
 * DEDICATED WORKER (the worker script load + the worker's fetch), which frame-scoped CDP Fetch
 * interception cannot settle — the regression class where worker-backed stories died at the
 * ready-signal timeout.
 *
 * By default the fixture also exposes a minimal `window.__STORYBOOK_ADDONS_CHANNEL__` whose
 * `emit("setCurrentStory", ...)` re-renders the requested story in place and channel-emits
 * `storyRendered` — exercising the worker's in-place story switching (issue #474 Phase B). The
 * channel is assigned from a page script AFTER the worker's init script has installed its
 * defineProperty hook, so listeners attach at assignment time (exactly like a real Storybook
 * preview boot). With `legacy: true` (--legacy-fixture) the pre-#474 channel-less HTML is
 * generated instead: only the synchronous `?id=` render exists, so the worker's soft-switch
 * probe finds no channel and hard-navigates every story (the fallback-ladder path).
 */
function fixtureIframeHtml(storyCount, workerStoryCount, { legacy = false } = {}) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>vizdiff e2e scale fixture${legacy ? " (legacy)" : ""}</title>
<style>html, body { margin: 0; padding: 0; background: #ffffff; }</style>
</head>
<body>
<div id="storybook-root"></div>
<script>
(function () {
  "use strict";
  var STORY_COUNT = ${storyCount};
  var WORKER_STORY_COUNT = ${workerStoryCount};

  var stories = {};
  for (var i = 0; i < STORY_COUNT; i++) {
    var group = Math.floor(i / 25);
    var id = "e2e-scale-group" + group + "--story-" + i;
    stories[id] = {
      id: id,
      kind: "E2E/Scale/Group" + group,
      title: "E2E/Scale/Group" + group,
      name: "Story" + i,
      importPath: "./stories/e2e-scale-group" + group + ".stories.js",
      componentPath: "",
      tags: ["story"],
      parameters: {}
    };
  }
  // Worker-backed stories (issue #473): readiness is only signaled from a dedicated Worker's
  // onmessage, after the worker itself fetches a same-origin binary.
  for (var wi = 0; wi < WORKER_STORY_COUNT; wi++) {
    var wid = "e2e-scale-worker--worker-story-" + wi;
    stories[wid] = {
      id: wid,
      kind: "E2E/Scale/Worker",
      title: "E2E/Scale/Worker",
      name: "WorkerStory" + wi,
      importPath: "./stories/e2e-scale-worker.stories.js",
      componentPath: "",
      tags: ["story"],
      parameters: { useReadySignal: true }
    };
  }

  // Deterministic per-story color (FNV-1a over the story id).
  function colorFor(id) {
    var h = 2166136261;
    for (var i = 0; i < id.length; i++) {
      h = ((h ^ id.charCodeAt(i)) * 16777619) >>> 0;
    }
    return "rgb(" + (h & 255) + "," + ((h >> 8) & 255) + "," + ((h >> 16) & 255) + ")";
  }

  var preview = {
    ready: true,
    storyStore: {
      cacheAllCSFFiles: function () { return Promise.resolve(); }
    },
    extract: function () { return Promise.resolve(stories); },
    currentRender: undefined
  };
  window.__STORYBOOK_PREVIEW__ = preview;

${
    legacy
      ? `  // Legacy (pre-#474) behavior: synchronous ?id= render only, NO preview channel — the
  // worker's soft-switch probe finds nothing to emit on and hard-navigates every story.
  var storyId = new URLSearchParams(window.location.search).get("id");
  if (storyId != null) {
    var story = stories[storyId];
    if (!story) {
      preview.currentRender = { id: storyId, phase: "errored" };
      return;
    }
    var div = document.createElement("div");
    div.style.width = "600px";
    div.style.height = "300px";
    div.style.boxSizing = "border-box";
    div.style.padding = "16px";
    div.style.background = colorFor(storyId);
    div.style.color = "#ffffff";
    div.style.font = "16px/1.4 monospace";
    div.textContent = story.title + " / " + story.name + " (" + storyId + ")";
    document.getElementById("storybook-root").appendChild(div);
    // Semantic render-completion signal (worker/src/storyReady.ts polls currentRender.phase).
    preview.currentRender = { id: storyId, phase: "completed" };

    // Worker-backed story (issue #473): render completes immediately (above), but the explicit
    // ready signal (parameters.useReadySignal) is only set once a dedicated Worker has fetched
    // worker-data.bin and posted back — mirroring chart.js-in-OffscreenCanvas storybooks whose
    // readiness depends on worker-owned network requests.
    if (story.parameters && story.parameters.useReadySignal) {
      var worker = new Worker("worker-fixture.js");
      worker.onmessage = function (event) {
        if (event.data && event.data.ok) {
          div.textContent = story.title + " / " + story.name +
            " (worker ok, " + event.data.bytes + " bytes)";
          window.__VIZDIFF_STORY_READY__ = true;
        } else {
          div.textContent = story.title + " / " + story.name +
            " (worker error: " + (event.data && event.data.error) + ")";
          // Ready signal deliberately NOT set: a failed worker fetch must fail the story.
        }
      };
    }
  }`
      : `  // Renders a story into the root, updates currentRender, and channel-emits storyRendered —
  // shared by the initial ?id= hard-navigation load and in-place setCurrentStory switches
  // (issue #474 Phase B).
  function renderStoryById(storyId) {
    var root = document.getElementById("storybook-root");
    root.innerHTML = "";
    var story = stories[storyId];
    if (!story) {
      preview.currentRender = { id: storyId, phase: "errored" };
      window.__STORYBOOK_ADDONS_CHANNEL__.emit("storyErrored",
        { storyId: storyId, message: "no such story: " + storyId });
      return;
    }
    var div = document.createElement("div");
    div.style.width = "600px";
    div.style.height = "300px";
    div.style.boxSizing = "border-box";
    div.style.padding = "16px";
    div.style.background = colorFor(storyId);
    div.style.color = "#ffffff";
    div.style.font = "16px/1.4 monospace";
    div.textContent = story.title + " / " + story.name + " (" + storyId + ")";
    root.appendChild(div);
    // Semantic render-completion signals: the SB8-style currentRender phase AND the channel
    // event (the worker's soft-mode readiness requires a story-scoped signal, issue #474).
    preview.currentRender = { id: storyId, phase: "completed" };
    window.__STORYBOOK_ADDONS_CHANNEL__.emit("storyRendered", storyId);

    // Worker-backed story (issue #473): render completes immediately (above), but the explicit
    // ready signal (parameters.useReadySignal) is only set once a dedicated Worker has fetched
    // worker-data.bin and posted back — mirroring chart.js-in-OffscreenCanvas storybooks whose
    // readiness depends on worker-owned network requests. Works in both navigation modes: a
    // soft switch re-arms __VIZDIFF_STORY_READY__ via the init script's reset() before the
    // switch is emitted.
    if (story.parameters && story.parameters.useReadySignal) {
      var worker = new Worker("worker-fixture.js");
      worker.onmessage = function (event) {
        if (event.data && event.data.ok) {
          div.textContent = story.title + " / " + story.name +
            " (worker ok, " + event.data.bytes + " bytes)";
          window.__VIZDIFF_STORY_READY__ = true;
        } else {
          div.textContent = story.title + " / " + story.name +
            " (worker error: " + (event.data && event.data.error) + ")";
          // Ready signal deliberately NOT set: a failed worker fetch must fail the story.
        }
      };
    }
  }

  // Minimal Storybook preview channel (issue #474): assigned AFTER the worker's init script has
  // installed its defineProperty hook on __STORYBOOK_ADDONS_CHANNEL__, so the assignment below
  // triggers the hook and the worker's lifecycle listeners attach immediately — exactly like a
  // real Storybook preview boot.
  window.__STORYBOOK_ADDONS_CHANNEL__ = {
    _l: {},
    on: function (t, f) { (this._l[t] = this._l[t] || []).push(f); },
    off: function () {},
    emit: function (t, p) {
      if (t === "setCurrentStory") { renderStoryById(p.storyId); }
      (this._l[t] || []).forEach(function (f) { f(p); });
    }
  };

  // Initial hard-navigation load renders synchronously, like the legacy fixture.
  var storyId = new URLSearchParams(window.location.search).get("id");
  if (storyId != null) {
    renderStoryById(storyId);
  }`
  }
})();
</script>
</body>
</html>
`
}

/**
 * Dedicated-worker script for the worker-backed stories: fetch a same-origin binary FROM THE
 * WORKER REALM (the request is owned by the worker target, not the frame), then post the result.
 */
function fixtureWorkerJs() {
  return `"use strict";
// Fetched from the dedicated worker, so the request is owned by the worker target (issue #473).
fetch("worker-data.bin")
  .then(function (res) {
    if (!res.ok) { throw new Error("HTTP " + res.status); }
    return res.arrayBuffer();
  })
  .then(function (buf) { self.postMessage({ ok: true, bytes: buf.byteLength }); })
  .catch(function (err) { self.postMessage({ ok: false, error: String(err) }); });
`
}

function buildFixtureTarball(storyCount, workerStoryCount, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vizdiff-e2e-scale-"))
  fs.writeFileSync(
    path.join(dir, "iframe.html"),
    fixtureIframeHtml(storyCount, workerStoryCount, { legacy }),
  )
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><title>vizdiff e2e scale fixture</title>\n",
  )
  // Always shipped, even with --worker-stories 0, so the fixture layout is stable.
  fs.writeFileSync(path.join(dir, "worker-fixture.js"), fixtureWorkerJs())
  // Deterministic 64-byte binary payload for the worker's fetch.
  fs.writeFileSync(path.join(dir, "worker-data.bin"), Buffer.alloc(64, 0x56)) // "V"
  const tarballPath = path.join(dir, "storybook.tar.gz")
  // Root layout: the worker extracts to the static-server root and loads /iframe.html, so
  // iframe.html must sit at the top of the archive (no wrapping directory).
  execFileSync("tar", [
    "-czf",
    tarballPath,
    "-C",
    dir,
    "iframe.html",
    "index.html",
    "worker-fixture.js",
    "worker-data.bin",
  ])
  return { dir, tarballPath }
}

// --- bootstrap ----------------------------------------------------------------------------------

/**
 * Creates (or refreshes) a harness user + project directly in the stack's Postgres via
 * `docker compose exec postgres psql`. Idempotent: re-runs rotate the project token.
 */
function bootstrapProject(opts) {
  const token = crypto.randomBytes(8).toString("hex")
  const sql = `
WITH u AS (
  INSERT INTO users (auth_subject, auth_provider, display_name, email)
  VALUES ('e2e-scale-harness', 'e2e', 'E2E Scale Harness', 'e2e-scale@vizdiff.invalid')
  ON CONFLICT (auth_subject) DO UPDATE SET updated_at = NOW()
  RETURNING id
)
INSERT INTO projects (user_id, name, token, vcs_provider, repo_id, repo_url, gitlab_host, key)
SELECT u.id, 'e2e-scale-harness', '${token}', 'gitlab', 990456001,
       'https://gitlab.invalid/e2e/scale-harness', 'https://gitlab.invalid', ''
FROM u
ON CONFLICT (vcs_provider, repo_id, gitlab_host, key)
  DO UPDATE SET token = EXCLUDED.token, user_id = EXCLUDED.user_id
RETURNING id, user_id;`
  const out = psql(opts, sql)
  const line = out.split("\n").find((l) => /^\d+\|\d+$/.test(l.trim())) ?? ""
  const [projectId, userId] = line.split("|").map((v) => parseInt(v, 10))
  if (!Number.isInteger(projectId) || !Number.isInteger(userId)) {
    throw new Error(`Unexpected bootstrap output: ${JSON.stringify(out)}`)
  }
  return { projectId, userId, token }
}

// --- kill-worker drill --------------------------------------------------------------------------

/**
 * Waits until a render_story_chunk task for the build is claimed (locked) by a worker, then
 * `docker kill`s that worker's container (locked_by is the container hostname == container id
 * prefix). SIGKILL, deliberately: no graceful shutdown, no lock release — the crash path.
 */
async function killChunkWorker(opts, testId, deadlineMs) {
  log("kill-worker: waiting for a claimed render_story_chunk task...")
  while (Date.now() < deadlineMs) {
    const out = psql(
      opts,
      `SELECT locked_by FROM task_queue
       WHERE screenshot_test_id = ${testId} AND task_type = 'render_story_chunk'
         AND locked_at IS NOT NULL AND locked_by IS NOT NULL
       ORDER BY id ASC LIMIT 1;`,
    )
    const lockedBy = out.split("\n")[0]?.trim()
    if (lockedBy) {
      const ps = dockerExec(["ps", "--format", "{{.ID}} {{.Names}}"])
      const match = ps
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .find(([id]) => id && lockedBy.startsWith(id))
      if (!match) {
        throw new Error(`No running container matches chunk lock owner "${lockedBy}"`)
      }
      const [containerId, containerName] = match
      log(`kill-worker: chunk claimed by ${containerName} (${containerId}); sending docker kill`)
      dockerExec(["kill", containerId])
      log(`kill-worker: killed ${containerName}. Restart it later with docker compose up -d.`)
      return containerName
    }
    await sleep(1000)
  }
  throw new Error("kill-worker: no render_story_chunk task was claimed before the budget expired")
}

// --- main ---------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv)
  const dotEnv = loadDotEnv()
  const jwtSecret = opts.jwtSecret ?? process.env.JWT_SECRET ?? dotEnv.JWT_SECRET
  if (!jwtSecret) {
    fail(
      "No JWT secret available for the polling session (looked at --jwt-secret, $JWT_SECRET, " +
        "and .env). It must match the api's JWT_SECRET.",
      2,
    )
  }

  // Worker-backed stories are additional to --stories; every count assertion below uses the total.
  const totalStories = opts.stories + opts.workerStories

  console.log(`vizdiff e2e scale harness (issue #456)
  stories:        ${opts.stories} plain + ${opts.workerStories} worker-backed = ${totalStories}
  budget:         ${opts.budgetSeconds}s
  api:            ${opts.apiUrl}
  kill-worker:    ${opts.killWorker ? "yes" : "no"}
  fixture:        ${opts.legacyFixture ? "legacy (channel-less; hard-nav per story)" : "channel (in-place story switching, issue #474)"}
`)

  // 1. Project + session.
  let { token, projectId, userId } = opts
  if (!token) {
    log("Bootstrapping harness user + project in the stack's Postgres (docker compose exec)...")
    ;({ token, projectId, userId } = bootstrapProject(opts))
    log(`Bootstrapped project ${projectId} (user ${userId}), token ${token}`)
  }
  userId ??= 1
  const jwt = mintSessionJwt(userId, jwtSecret)
  const authHeaders = { jwt }

  if (projectId == undefined) {
    const projects = await apiJson(`${opts.apiUrl}/api/projects`, { headers: authHeaders })
    const project = projects.find((p) => p.token === token)
    if (!project) fail(`No project with the given token visible via GET /api/projects`, 2)
    projectId = project.id
    log(`Resolved project id ${projectId} from token`)
  }

  // 2. Fixture.
  log(
    `Generating static storybook fixture (${opts.stories} plain + ${opts.workerStories} ` +
      `worker-backed stories)...`,
  )
  const { dir, tarballPath } = buildFixtureTarball(opts.stories, opts.workerStories, {
    legacy: opts.legacyFixture,
  })
  const tarball = fs.readFileSync(tarballPath)
  log(`Fixture tarball: ${tarballPath} (${(tarball.length / 1024).toFixed(1)} KiB)`)

  try {
    // 3. Upload.
    const commitSha = crypto.randomBytes(20).toString("hex")
    const branch = "e2e-scale"
    log(`Uploading storybook (commit ${commitSha.slice(0, 12)}, branch ${branch})...`)
    const startMs = Date.now()
    const upload = await apiJson(
      `${opts.apiUrl}/api/upload/storybook?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/gzip",
          "x-vizdiff-commit-sha": commitSha,
          "x-vizdiff-branch": branch,
        },
        body: tarball,
      },
    )
    const testId = upload.testId
    if (!Number.isInteger(testId)) fail(`Upload did not return a testId: ${JSON.stringify(upload)}`)
    log(`Upload accepted: build/test id ${testId}, upload id ${upload.uploadId}`)

    const deadlineMs = startMs + opts.budgetSeconds * 1000

    // 4. Optional kill drill (runs while the build is in flight).
    let killedContainer
    if (opts.killWorker) {
      killedContainer = await killChunkWorker(opts, testId, deadlineMs)
    }

    // 5. Poll until terminal.
    let build
    let sweeperWarned = false
    for (;;) {
      const elapsedSec = (Date.now() - startMs) / 1000
      const page = await apiJson(`${opts.apiUrl}/api/projects/${projectId}/builds?limit=25`, {
        headers: authHeaders,
      })
      build = page.builds.find((b) => b.id === testId)
      if (!build) fail(`Build ${testId} not found in GET /api/projects/${projectId}/builds`)
      log(
        `build ${testId}: status=${build.status} results=${build.stories}/${totalStories} ` +
          `changes=${build.changes} elapsed=${elapsedSec.toFixed(0)}s`,
      )
      if (TERMINAL_STATUSES.has(build.status)) break
      if (
        build.status === "running" &&
        elapsedSec > SWEEPER_THRESHOLD_SEC + 600 &&
        !sweeperWarned
      ) {
        sweeperWarned = true
        console.error(
          `WARNING: build still "running" ${elapsedSec.toFixed(0)}s after upload — beyond the ` +
            `stuck-build sweeper threshold (~${SWEEPER_THRESHOLD_SEC}s) plus slack. The sweeper ` +
            `should have failed it by now; something is wrong with the recovery path.`,
        )
      }
      if (Date.now() >= deadlineMs) {
        fail(
          `Budget exceeded: build ${testId} still "${build.status}" after ${opts.budgetSeconds}s` +
            (sweeperWarned ? " (and it outlived the stuck-build sweeper threshold)" : ""),
        )
      }
      await sleep(opts.pollIntervalSeconds * 1000)
    }

    const wallClockSec = (Date.now() - startMs) / 1000

    // 6. Final verification via GET /api/tests/:id (authoritative per-story results).
    const test = await apiJson(`${opts.apiUrl}/api/tests/${testId}`, { headers: authHeaders })
    const byStatus = {}
    for (const result of test.testResults) {
      byStatus[result.changeStatus] = (byStatus[result.changeStatus] ?? 0) + 1
    }
    for (const result of test.testResults) {
      if (result.changeStatus === "failed") {
        console.error(
          `  failed story: ${result.storyId} kind=${result.errorKind ?? "?"} ` +
            `message=${JSON.stringify(result.errorMessage ?? "")}`,
        )
      }
    }

    console.log(
      `\n=== Result ===============================================
  terminal status:   ${build.status}
  test results:      ${test.testResults.length} / ${totalStories} expected
  by change status:  ${JSON.stringify(byStatus)}
  wall clock:        ${wallClockSec.toFixed(1)}s (budget ${opts.budgetSeconds}s)` +
        (killedContainer ? `\n  killed worker:     ${killedContainer}` : "") +
        `\n==========================================================\n`,
    )

    // 7. Assertions.
    const failures = []
    if (!PASSING_STATUSES.has(build.status)) {
      failures.push(
        `terminal status "${build.status}" is not in {no_changes, unapproved}` +
          (opts.killWorker
            ? " — with --kill-worker this usually means the killed worker's chunk was never " +
              "retried (task lock not yet expired) and the stuck-build sweeper failed the build"
            : ""),
      )
    }
    if (test.testResults.length !== totalStories) {
      failures.push(`expected ${totalStories} test results, got ${test.testResults.length}`)
    }
    if (wallClockSec >= opts.budgetSeconds) {
      failures.push(`wall clock ${wallClockSec.toFixed(1)}s exceeded budget ${opts.budgetSeconds}s`)
    }
    if ((byStatus.failed ?? 0) > 0) {
      failures.push(`${byStatus.failed} story result(s) have changeStatus "failed"`)
    }

    if (failures.length > 0) {
      fail(failures.map((f) => `  - ${f}`).join("\n"))
    }
    console.log("PASS: all assertions held.")
  } finally {
    if (opts.keepFixture) {
      log(`Keeping fixture dir: ${dir}`)
    } else {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

main().catch((err) => {
  fail(err?.stack ?? String(err), 2)
})
