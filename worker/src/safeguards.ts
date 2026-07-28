import type { Browser } from "webdriverio"

import { log } from "./log"

/**
 * Browser safeguards for rendering untrusted Storybook bundles (issue #69).
 *
 * User uploads contain arbitrary HTML/CSS/JS that we execute in a headless
 * Chrome instance. This module hardens that execution against exfiltration and
 * abuse via two complementary layers:
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
 *     restore them.
 *
 *  3. A WebDriver BiDi network interceptor ({@link installNetworkEgressBlock})
 *     that fails every off-origin request (sub-resource, navigation, fetch,
 *     XHR, WebSocket, beacon) at the network layer. This is the hard boundary:
 *     page script cannot undo it, so no data can leave the same-origin static
 *     server regardless of how the bundle tries.
 *
 * Defense-in-depth note: the init script (layer 2) runs inside the page and is
 * not a hard boundary on its own — a sufficiently adversarial bundle could
 * capture references before our script runs, and some native methods (notably
 * `location.assign`/`replace`, which are non-configurable own properties in
 * Chrome) cannot be reliably overridden from page JS at all. Layer 3 (the BiDi
 * network interceptor) is therefore the authoritative egress control; the init
 * script is a fast-failing convenience layer that gives clean errors to the
 * page. Both depend on WebDriver BiDi (`webSocketUrl: true`).
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

export interface ChromeArgsOptions {
  /**
   * Opt in to software (SwiftShader) WebGL for story rendering. Default false:
   * appends {@link DISABLE_WEBGL_CHROME_ARGS}; true appends
   * {@link ENABLE_WEBGL_CHROME_ARGS} instead.
   */
  enableWebgl?: boolean
  /**
   * Operator-supplied Chrome flags appended after the hardening and WebGL
   * flags. Appending can only add flags, not remove earlier ones, so the
   * hardening set stays intact.
   */
  extraArgs?: readonly string[]
}

/**
 * Returns the full Chrome args array: the base flags, the hardening flags, the
 * WebGL flags per `options.enableWebgl`, and any operator extra args — in that
 * order, de-duplicated while preserving first occurrence.
 */
export function hardenedChromeArgs(
  baseArgs: readonly string[],
  options: ChromeArgsOptions = {},
): string[] {
  const webglArgs = options.enableWebgl ? ENABLE_WEBGL_CHROME_ARGS : DISABLE_WEBGL_CHROME_ARGS
  const seen = new Set<string>()
  const result: string[] = []
  for (const arg of [
    ...baseArgs,
    ...HARDENING_CHROME_ARGS,
    ...webglArgs,
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
 * Installs a WebDriver BiDi network interceptor that fails every off-origin
 * request — sub-resources, top-level navigations, `fetch`, `XMLHttpRequest`,
 * WebSocket handshakes and beacons alike. Only requests whose origin matches
 * `allowedOrigin` (the local static server) or use a non-network scheme are
 * allowed through.
 *
 * Unlike the page init script, this is a hard boundary: it lives in the driver,
 * so untrusted page script cannot disable it. This is what actually prevents
 * data exfiltration from an untrusted story bundle.
 *
 * Must be called after the static server is up (so its origin is known) and
 * before navigating to any story. Swallows errors if BiDi is unavailable so
 * that rendering still works (the Chrome hardening flags and localhost-only
 * server remain in effect).
 *
 * @param browser The WebDriverIO BiDi-enabled browser session.
 * @param allowedOrigin The same-origin to allow, e.g. `http://localhost:6230`.
 */
export async function installNetworkEgressBlock(
  browser: Browser,
  allowedOrigin: string,
): Promise<void> {
  try {
    // Intercept all requests at the "before request sent" phase so we can fail
    // off-origin ones before any bytes leave the machine.
    await browser.networkAddIntercept({ phases: ["beforeRequestSent"] })
    await browser.sessionSubscribe({ events: ["network.beforeRequestSent"] })

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
      void settle.catch((err: unknown) => {
        log.debug({ err, url, allowed }, "Failed to settle intercepted request")
      })
      if (!allowed) {
        log.debug({ url }, "Blocked off-origin request (network egress safeguard)")
      }
    })

    log.info({ allowedOrigin }, "Installed network egress safeguard (off-origin requests blocked)")
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
