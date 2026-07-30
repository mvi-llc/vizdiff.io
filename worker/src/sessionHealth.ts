import type { Browser } from "webdriverio"

import { WORKER_SESSION_PROBE_TIMEOUT_MS } from "./environment"
import { log } from "./log"

/**
 * Cheap health probe for a pooled browser session (issue #450).
 *
 * A Chrome process that was OOM-killed mid-build leaves a dead WebDriverIO BiDi session behind;
 * every command against it burns the full 60 s BiDi command timeout. Probing with a trivial
 * `execute` under a short *local* timeout detects that death in milliseconds-to-seconds instead,
 * so the render loop can replace the session before paying a story's full per-command timeout
 * chain.
 *
 * Returns `false` if the probe rejects or does not settle within `timeoutMs`; never throws.
 */
export async function probeSession(
  browser: Browser,
  timeoutMs = WORKER_SESSION_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    const probe = browser
      .execute(() => 1)
      .then(
        () => true as const,
        (err: unknown) => {
          log.debug(err, "Session health probe rejected")
          return false as const
        },
      )
    return await Promise.race([probe, timeout])
  } catch (err) {
    // `browser.execute` threw synchronously (e.g. a torn-down client object).
    log.debug(err, "Session health probe threw")
    return false
  } finally {
    clearTimeout(timer)
  }
}
