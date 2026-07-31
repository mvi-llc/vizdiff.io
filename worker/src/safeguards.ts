import type { Browser } from "webdriverio"

import type { WorkerEgressBlockMode } from "./environment"
import { log } from "./log"

/**
 * Browser safeguards for rendering untrusted Storybook bundles (issue #69).
 *
 * User uploads contain arbitrary HTML/CSS/JS that we execute in a headless
 * Chrome instance. This module hardens that execution against exfiltration and
 * abuse via three complementary layers:
 *
 *  1. Chrome launch flags ({@link hardenedChromeArgs}) that disable risky
 *     platform features (WebRTC, background networking, etc.) at the browser
 *     level. These are applied via `goog:chromeOptions.args` and cannot be
 *     undone by page script.
 *
 *  2. A page-level init script ({@link safeguardInitScript}) installed before
 *     any story code runs. It neutralizes real-time transports and off-origin
 *     `fetch`/`XMLHttpRequest`/`sendBeacon` and `window.open` at the JS layer.
 *     Transport globals are redefined non-configurably so page scripts cannot
 *     restore them. It runs only in page (frame) contexts — dedicated workers
 *     never see it.
 *
 *  3. A network-layer egress block, selected by WORKER_EGRESS_BLOCK_MODE
 *     (issue #473; see environment.ts):
 *
 *     - "resolver" (default): Chrome launches with
 *       `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost`
 *       ({@link RESOLVER_EGRESS_CHROME_ARGS}), so every non-localhost HOSTNAME
 *       fails DNS resolution in every context — pages, dedicated/shared/service
 *       workers, font fetches, CSS/img subresources, navigations, WebSockets.
 *       Nothing is intercepted or paused, so nothing can wedge.
 *       {@link installNetworkEgressBlock} installs nothing in this mode.
 *     - "intercept": {@link installNetworkEgressBlock} adds a BiDi network
 *       intercept that pauses every request at the beforeRequestSent phase and
 *       fails off-origin ones. This was the pre-#473 authoritative control,
 *       kept as an escape hatch.
 *     - "off": no network-layer control (layers 1 and 2 remain).
 *
 * Why "resolver" is the default (issue #473, measured empirically): Chromium
 * implements BiDi network interception on top of the CDP Fetch domain, and
 * requests owned by dedicated-worker targets — including Chromium's font
 * resource loads — intermittently cannot be settled: `network.continueRequest`
 * / `network.failRequest` fail with "'Fetch.continueRequest' wasn't found" and
 * the request stays paused FOREVER. Under production load this wedged
 * same-origin font/worker fetches, failing every font-gated story at the
 * ready-signal timeout. No release mechanism works once a request is in that
 * state (an immediate networkFailRequest fallback and a delayed retry both
 * keep failing — measured), so interception is structurally unsafe for
 * worker-owned requests. Scoping the intercept to top-level browsing contexts
 * (BiDi `contexts`) was also measured and wedges identically: worker-owned
 * requests are attributed to their owning frame's context and still get
 * intercepted, which is why no "scoped" mode is offered.
 *
 * Resolver-mode coverage notes (empirical on the shipped Chromium 150,
 * documented also in docs/CONFIGURATION.md):
 *
 *  - IP-LITERAL URLs ARE blocked: Chromium applies `MAP * ~NOTFOUND` before
 *    the IP-literal short-circuit, so `http://203.0.113.7/x` fails fast with
 *    ERR_NAME_NOT_RESOLVED, from page and worker contexts alike. This also
 *    covers `127.0.0.1`/`::1` (only the literal hostname `localhost` is
 *    excluded).
 *  - The remaining gap: the `localhost` hostname itself resolves normally on
 *    EVERY port (DNS rules cannot see ports), so anything else listening on
 *    localhost inside the worker container/pod is reachable from worker
 *    contexts. Layer 2 still blocks page-context fetch/XHR to other localhost
 *    ports (different origin) — dedicated workers were always outside layer 2
 *    — and worker containers run no other listeners on localhost besides
 *    chromedriver and the worker health port.
 *
 * Defense-in-depth note: the init script (layer 2) runs inside the page and is
 * not a hard boundary on its own — a sufficiently adversarial bundle could
 * capture references before our script runs, and some native methods (notably
 * `location.assign`/`replace`, which are non-configurable own properties in
 * Chrome) cannot be reliably overridden from page JS at all. The network-layer
 * control (layer 3) is therefore the authoritative egress control; the init
 * script is a fast-failing convenience layer that gives clean errors to the
 * page.
 */

/**
 * The hostname our local static server is bound to. All same-origin traffic is
 * served from here; everything else is considered "off-origin" and untrusted.
 */
export const ALLOWED_HOST = "localhost"

/**
 * Additional Chrome launch flags that harden the browser against untrusted
 * page content. Merged into the base `goog:chromeOptions.args`.
 *
 * Each flag is conservative: it disables a feature that legitimate Storybook
 * stories do not need for static visual rendering, so enabling them should not
 * destabilize screenshots.
 */
export const HARDENING_CHROME_ARGS: readonly string[] = [
  // Disable WebRTC entirely (STUN/TURN/data channels are a common exfil/peer
  // vector and are almost never needed to render a static story).
  "--disable-webrtc",
  "--enforce-webrtc-ip-permission-check",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  // Block all background networking Chrome itself initiates.
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--no-pings",
  // Disable speculative/preconnect networking that could reach arbitrary hosts.
  "--dns-prefetch-disable",
  // Reduce the feature surface: turn off a set of risky/experimental web
  // platform features that untrusted content might abuse.
  "--disable-features=WebRtcHideLocalIpsWithMdns,MediaRouter,DialMediaRouteProvider",
  // Do not allow the renderer to open external protocol handlers.
  "--disable-external-intent-requests",
]

/**
 * Flags appended when software WebGL is disabled (the default). The worker
 * image ships SwiftShader (Alpine's `chromium-swiftshader` package), so WebGL
 * would otherwise be live by default; this keeps the hardened no-GL posture
 * explicit — SwiftShader is in-process software rasterization driven by
 * untrusted story content, a larger attack surface than no GL at all.
 */
export const DISABLE_WEBGL_CHROME_ARGS: readonly string[] = ["--disable-webgl"]

/**
 * Flags appended when software WebGL is opted in (issue #447). SwiftShader
 * renders WebGL on the CPU; `--enable-unsafe-swiftshader` lifts the software-GL
 * gate that recent Chrome builds impose (a no-op on builds that don't gate it,
 * such as the Alpine Chromium in the worker image).
 */
export const ENABLE_WEBGL_CHROME_ARGS: readonly string[] = ["--enable-unsafe-swiftshader"]

/**
 * Flags appended when WORKER_EGRESS_BLOCK_MODE is "resolver" (the default;
 * issue #473): every hostname except localhost fails DNS resolution, blocking
 * off-origin egress for EVERY context (pages, workers, fonts, subresources)
 * at Chrome launch time — with no request interception that could wedge.
 * chromedriver launches a fresh Chrome process per WebDriver session from the
 * capabilities args, so the rules apply to every screenshot session.
 *
 * Coverage (measured on the shipped Chromium 150): hostnames AND IP-literal
 * URLs both fail with ERR_NAME_NOT_RESOLVED (the mapping applies before the
 * IP-literal short-circuit); only the literal hostname `localhost` — on any
 * port — is exempt. See the module header for the residual-gap discussion.
 */
export const RESOLVER_EGRESS_CHROME_ARGS: readonly string[] = [
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
]

export interface ChromeArgsOptions {
  /**
   * Opt in to software (SwiftShader) WebGL for story rendering. Default false:
   * appends {@link DISABLE_WEBGL_CHROME_ARGS}; true appends
   * {@link ENABLE_WEBGL_CHROME_ARGS} instead.
   */
  enableWebgl?: boolean
  /**
   * Network egress blocking mode (issue #473). "resolver" appends
   * {@link RESOLVER_EGRESS_CHROME_ARGS}; the other modes add no launch flags
   * (their enforcement, if any, is installed per session via
   * {@link installNetworkEgressBlock}). Default: no resolver flags, so callers
   * that don't render untrusted content (e.g. dev screenshot tooling) keep
   * full network access.
   */
  egressBlockMode?: WorkerEgressBlockMode
  /**
   * Operator-supplied Chrome flags appended after the hardening and WebGL
   * flags. Appending can only add flags, not remove earlier ones, so the
   * hardening set stays intact.
   */
  extraArgs?: readonly string[]
}

/**
 * Returns the full Chrome args array: the base flags, the hardening flags, the
 * WebGL flags per `options.enableWebgl`, the resolver-based egress rules when
 * `options.egressBlockMode` is "resolver", and any operator extra args — in
 * that order, de-duplicated while preserving first occurrence.
 */
export function hardenedChromeArgs(
  baseArgs: readonly string[],
  options: ChromeArgsOptions = {},
): string[] {
  const webglArgs = options.enableWebgl ? ENABLE_WEBGL_CHROME_ARGS : DISABLE_WEBGL_CHROME_ARGS
  const egressArgs = options.egressBlockMode === "resolver" ? RESOLVER_EGRESS_CHROME_ARGS : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const arg of [
    ...baseArgs,
    ...HARDENING_CHROME_ARGS,
    ...webglArgs,
    ...egressArgs,
    ...(options.extraArgs ?? []),
  ]) {
    if (!seen.has(arg)) {
      seen.add(arg)
      result.push(arg)
    }
  }
  return result
}

/**
 * Page init-script source, evaluated in the page context before any story
 * script runs. It is intentionally written as a self-contained function with no
 * external references so it can be serialized via `addInitScript`.
 *
 * Behavior:
 *  - Blocks `window.open` to non-same-origin URLs (same-origin == the local
 *    static server).
 *  - Disables real-time transports entirely: WebSocket, WebTransport, RTCPeer-
 *    Connection, EventSource. These globals are redefined non-configurably so a
 *    later page script (e.g. MSW's WebSocket interceptor) cannot restore them.
 *  - Blocks off-origin `fetch` and `XMLHttpRequest`; same-origin requests pass
 *    through unchanged so legitimate Storybook assets still load.
 *
 * Note: off-origin top-level navigation via `location.assign`/`replace` is NOT
 * handled here. Those are non-configurable own properties of `Location` in
 * Chrome and cannot be overridden from page JS; off-origin navigation egress is
 * instead blocked by {@link installNetworkEgressBlock} at the network layer.
 */
export function safeguardInitScript(): void {
  // Runs in the browser. `window`, `document`, `location` are page globals.
  /* eslint-disable */
  // @ts-nocheck
  try {
    // @ts-ignore
    const w: any = window
    // @ts-ignore
    const loc = w.location

    const sameOrigin = (url: any): boolean => {
      try {
        // Relative URLs and hash/query-only URLs resolve to the page origin.
        const resolved = new w.URL(String(url), loc.href)
        return resolved.origin === loc.origin
      } catch {
        // Unparseable URLs (e.g. "javascript:", "about:blank") are treated as
        // same-origin / harmless navigations and allowed.
        return true
      }
    }

    const noop = function () {}

    // Note: off-origin `location.assign`/`replace` cannot be overridden here —
    // they are non-configurable own properties of the Location instance in
    // Chrome, so assignment silently no-ops and `Object.defineProperty` throws.
    // Off-origin navigation egress is blocked at the network layer instead (see
    // installNetworkEgressBlock). We still guard `window.open`, which IS
    // writable.

    const origOpen = w.open ? w.open.bind(w) : null
    // @ts-ignore
    w.open = (url?: any, ...rest: any[]) => {
      if (url == null || sameOrigin(url)) {
        return origOpen ? origOpen(url, ...rest) : null
      }
      return null
    }

    // --- Disable real-time transports ---
    // `Blocked` is a class so that `new WebSocket(...)` (construct call) throws;
    // a plain function does not reliably throw from a `new` expression in all
    // engines. We redefine each global non-configurably so a later page script
    // (e.g. MSW's WebSocketOverride, shipped by some story bundles) cannot
    // reassign the global and defeat the guard.
    class Blocked {
      constructor() {
        throw new w.DOMException("Blocked by vizdiff rendering safeguards", "SecurityError")
      }
    }
    const lockGlobal = (name: any): void => {
      try {
        Object.defineProperty(w, name, {
          value: Blocked,
          writable: false,
          configurable: false,
          enumerable: false,
        })
      } catch {
        // Fall back to a plain assignment if the property is already
        // non-configurable for some reason.
        try {
          // @ts-ignore
          w[name] = Blocked
        } catch {
          /* ignore non-writable globals */
        }
      }
    }
    for (const name of ["WebSocket", "WebTransport", "RTCPeerConnection", "EventSource"]) {
      lockGlobal(name)
    }
    // Some engines expose the webkit-prefixed variant.
    lockGlobal("webkitRTCPeerConnection")

    // --- Block off-origin fetch ---
    if (typeof w.fetch === "function") {
      const origFetch = w.fetch.bind(w)
      // @ts-ignore
      w.fetch = (input: any, init?: any) => {
        const url = typeof input === "string" ? input : input && input.url
        if (url == null || sameOrigin(url)) {
          return origFetch(input, init)
        }
        return w.Promise.reject(
          new w.DOMException("Blocked off-origin fetch by vizdiff safeguards", "SecurityError"),
        )
      }
    }

    // --- Block off-origin XMLHttpRequest ---
    if (w.XMLHttpRequest && w.XMLHttpRequest.prototype) {
      const origXhrOpen = w.XMLHttpRequest.prototype.open
      // @ts-ignore
      w.XMLHttpRequest.prototype.open = function (method: any, url: any, ...rest: any[]) {
        if (url != null && !sameOrigin(url)) {
          throw new w.DOMException(
            "Blocked off-origin XMLHttpRequest by vizdiff safeguards",
            "SecurityError",
          )
        }
        // @ts-ignore
        return origXhrOpen.call(this, method, url, ...rest)
      }
    }

    // --- Block sendBeacon (fire-and-forget exfil) entirely ---
    try {
      if (w.navigator && typeof w.navigator.sendBeacon === "function") {
        // @ts-ignore
        w.navigator.sendBeacon = () => false
      }
    } catch {
      /* ignore */
    }

    void noop
  } catch {
    // Never let safeguard installation crash the page.
  }
  /* eslint-enable */
}

/**
 * Installs the page-level safeguards on the given browser session. Must be
 * called once after the session is created and before navigating to any story.
 *
 * Uses WebDriver BiDi `addInitScript` so the guard is re-applied on every
 * document/navigation for the life of the session.
 */
export async function installBrowserSafeguards(browser: Browser): Promise<void> {
  try {
    await browser.addInitScript(safeguardInitScript)
    log.info("Installed page-level rendering safeguards (init script)")
  } catch (err) {
    // BiDi may be unavailable depending on the driver. Surface a warning but do
    // not fail rendering — the Chrome hardening flags and localhost-only server
    // remain in effect.
    log.warn(err, "Failed to install page-level rendering safeguards via init script")
  }
}

/**
 * URL schemes that never reach the network and are therefore always safe to
 * allow regardless of origin.
 */
const NON_NETWORK_SCHEMES = new Set(["data:", "blob:", "about:", "javascript:"])

/**
 * Returns true if the given request URL is allowed to proceed: same-origin as
 * the static server, or a non-network scheme (data:/blob:/about:/javascript:).
 * Unparseable URLs are allowed (they are rare and cannot carry an off-origin
 * egress target).
 */
function isAllowedRequestUrl(url: string, allowedOrigin: string): boolean {
  try {
    const u = new URL(url)
    return u.origin === allowedOrigin || NON_NETWORK_SCHEMES.has(u.protocol)
  } catch {
    return true
  }
}

/**
 * Installs the network-layer egress control for one browser session, per
 * `mode` (WORKER_EGRESS_BLOCK_MODE, issue #473):
 *
 *  - "resolver" (default): nothing to install here. Enforcement happened at
 *    Chrome launch via {@link RESOLVER_EGRESS_CHROME_ARGS} (wired in by
 *    {@link hardenedChromeArgs}); every non-localhost hostname fails DNS in
 *    every context and no request is ever intercepted, so nothing can wedge.
 *    In-flight request observation for failure diagnostics is handled
 *    independently by sessionDiagnostics.ts.
 *  - "intercept": the pre-#473 behavior. A WebDriver BiDi network interceptor
 *    pauses every request at the beforeRequestSent phase and fails off-origin
 *    ones — sub-resources, navigations, `fetch`, XHR, WebSocket handshakes and
 *    beacons alike. Only requests matching `allowedOrigin` (the local static
 *    server) or a non-network scheme are continued. CAUTION: requests owned by
 *    dedicated-worker targets (including Chromium font-resource loads)
 *    intermittently cannot be settled — `network.continueRequest` /
 *    `network.failRequest` fail with "'Fetch.<cmd>' wasn't found" and the
 *    request stays paused forever (issue #473). No recovery exists once that
 *    happens (measured: immediate networkFailRequest fallback and a delayed
 *    retry both keep failing), which is why this mode is no longer the
 *    default.
 *  - "off": no network-layer control. The page init script and Chrome
 *    hardening flags remain, but dedicated workers can reach the network —
 *    a documented last-resort workaround, surfaced with a warning.
 *
 * Must be called after the static server is up (so its origin is known) and
 * before navigating to any story. Swallows errors if BiDi is unavailable so
 * that rendering still works (the Chrome hardening flags and localhost-only
 * server remain in effect).
 *
 * @param browser The WebDriverIO BiDi-enabled browser session.
 * @param allowedOrigin The same-origin to allow, e.g. `http://localhost:6230`.
 * @param mode The egress blocking mode (default "resolver").
 */
export async function installNetworkEgressBlock(
  browser: Browser,
  allowedOrigin: string,
  mode: WorkerEgressBlockMode = "resolver",
): Promise<void> {
  if (mode === "resolver") {
    log.info(
      { allowedOrigin },
      "Network egress blocked via Chrome host-resolver rules (mode=resolver); no request interception",
    )
    return
  }
  if (mode === "off") {
    log.warn(
      "Network-layer egress blocking is DISABLED (WORKER_EGRESS_BLOCK_MODE=off); untrusted " +
        "story bundles can reach the network from worker contexts",
    )
    return
  }
  try {
    // Intercept requests at the "before request sent" phase so we can fail
    // off-origin ones before any bytes leave the machine.
    await browser.networkAddIntercept({ phases: ["beforeRequestSent"] })
    await browser.sessionSubscribe({ events: ["network.beforeRequestSent"] })

    // Telemetry dedupe: an unsettleable request typically repeats for the same asset (e.g. the
    // same font re-requested by every story), so warn once per URL-sans-query per session.
    const warnedUrlKeys = new Set<string>()

    browser.on("network.beforeRequestSent", (event: NetworkBeforeRequestSentEvent) => {
      const requestId = event.request?.request
      const url = event.request?.url ?? ""
      if (requestId == undefined) {
        return
      }
      const allowed = isAllowedRequestUrl(url, allowedOrigin)
      // Fire-and-forget: resolve/fail the paused request. We must not await here
      // (the event handler is sync) but we log failures for diagnosis.
      const settle = allowed
        ? browser.networkContinueRequest({ request: requestId })
        : browser.networkFailRequest({ request: requestId })
      void settle.catch(async (err: unknown) => {
        // Best-effort release (issue #473): try to fail the paused request, then retry once
        // after a short delay. Measured to be ineffective for the "'Fetch.<cmd>' wasn't found"
        // wedge (the request's CDP Fetch attachment is gone, so every settle command fails),
        // but it is cheap and covers transient failures of a different shape.
        let released = false
        try {
          await browser.networkFailRequest({ request: requestId })
          released = true
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
          try {
            if (allowed) {
              await browser.networkContinueRequest({ request: requestId })
            } else {
              await browser.networkFailRequest({ request: requestId })
            }
            released = true
          } catch {
            // Wedged for good; fall through to telemetry.
          }
        }
        if (!allowed && !released) {
          // A BLOCK that could not be enforced is a security-relevant event: the request is
          // (at best) paused rather than failed. Always error-level.
          log.error(
            { err, url },
            "Egress safeguard could NOT enforce the block on an off-origin request; the " +
              "request is stuck paused instead of failed",
          )
          return
        }
        const urlKey = url.split("?")[0] ?? url
        if (!warnedUrlKeys.has(urlKey)) {
          warnedUrlKeys.add(urlKey)
          log.warn(
            { err, url, allowed, released },
            `Egress interceptor could not settle an intercepted request${released ? " (released on retry)" : "; it will stay paused and the story will hang until its timeout"}. ` +
              "This is issue #473 (BiDi interception cannot settle worker-owned requests); " +
              "switch WORKER_EGRESS_BLOCK_MODE=resolver (the default) to avoid interception entirely",
          )
        }
      })
      if (!allowed) {
        log.debug({ url }, "Blocked off-origin request (network egress safeguard)")
      }
    })

    log.info(
      { allowedOrigin, mode },
      "Installed network egress safeguard (off-origin requests blocked via BiDi interception)",
    )
  } catch (err) {
    log.warn(err, "Failed to install network egress safeguard via BiDi")
  }
}

/**
 * Minimal shape of the BiDi `network.beforeRequestSent` event payload we use.
 * (WebdriverIO emits the raw BiDi event object.)
 */
interface NetworkBeforeRequestSentEvent {
  request?: {
    request?: string
    url?: string
  }
}
