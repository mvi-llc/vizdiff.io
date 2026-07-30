import type { Browser } from "webdriverio"

import { log } from "./log"

/**
 * A fixed-size pool of independent WebdriverIO browser sessions used to render the stories of a
 * single ingest concurrently (issue #152, Phase 1b).
 *
 * Each session is a separate headless-Chrome process, so a story rendered against one session is
 * fully isolated from a story rendered against another (separate storage/cache/cookies and, just
 * as importantly for untrusted bundles, a separate OS process — see issue #69). Because a slot
 * holds a session for the entire render of one story and only ever runs one story against it at a
 * time, no cross-session locking is needed: the pool's checkout/checkin is the only coordination.
 *
 * Sessions are now long-lived *slots* rather than immutable browsers (issues #450/#453): the
 * browser behind a {@link PooledSession} can be replaced mid-build — when a health probe finds it
 * dead, when consecutive infra failures condemn it, or when periodic recycling bounds Chrome's
 * cumulative memory growth — without disturbing the pool's checkout bookkeeping.
 */

/** How long to wait for a (possibly dead) session's `deleteSession` before abandoning it. */
const REPLACE_DELETE_TIMEOUT_MS = 10_000

/**
 * A pool slot: a mutable handle whose `browser` is swapped in place by {@link BrowserPool.replace}.
 * The counters drive replacement policy and are maintained by the render loop (stories.ts):
 * `storiesRendered` increments per successful render (periodic recycling, issue #453) and
 * `consecutiveInfraFailures` increments per infra-classified failure and resets on success
 * (dead-session condemnation, issue #450).
 */
export interface PooledSession {
  readonly id: number
  browser: Browser
  storiesRendered: number
  consecutiveInfraFailures: number
}

export interface BrowserPoolOptions {
  /** Replace a session after it has rendered this many stories. 0 (or unset) disables. */
  recycleAfterStories?: number
  /** Replace a session after this many consecutive infra failures. 0 (or unset) disables. */
  maxConsecutiveInfraFailures?: number
}

export interface BrowserPool {
  /** Number of sessions in the pool. */
  readonly size: number
  /** Every pool slot — for installing per-session safeguards and for teardown. */
  readonly sessions: readonly PooledSession[]
  /** Check out an available session, waiting if every session is currently in use. */
  acquire(): Promise<PooledSession>
  /**
   * Return a session to the pool. If the session has crossed a replacement threshold
   * (`recycleAfterStories` / `maxConsecutiveInfraFailures`), it is replaced BEFORE being handed
   * to the next waiter, so a waiter never receives a condemned session.
   */
  release(session: PooledSession): Promise<void>
  /**
   * Replace the session's browser with a freshly created one: best-effort close of the old
   * browser (bounded — a dead session's `deleteSession` can hang on the BiDi command timeout),
   * then the factory plus the `setSessionInit` callback, then counters reset to zero.
   */
  replace(session: PooledSession, reason: string): Promise<void>
  /**
   * Register a per-browser init callback run after the factory for every *replacement* browser
   * (the initial browsers are initialized by the caller directly). Used for the network egress
   * block, whose allowed origin is only known once the static server is up.
   */
  setSessionInit(init: (browser: Browser) => Promise<void>): void
  /** Close every session, tolerating sessions that are already gone. Safe to call twice. */
  destroyAll(): Promise<void>
}

/**
 * Best-effort close of a browser that may be dead: races `deleteSession()` against a local timer,
 * because a dead session's delete can itself hang on the 60 s BiDi command timeout. The delete's
 * rejection (or late settlement after the race) is swallowed either way.
 */
async function bestEffortDeleteSession(browser: Browser, reason: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REPLACE_DELETE_TIMEOUT_MS)
  })
  try {
    await Promise.race([
      browser.deleteSession().catch((err: unknown) => {
        log.debug(err, `browserPool: deleteSession during replace (${reason}) failed`)
      }),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Creates a pool of `size` sessions by invoking `createBrowser` that many times concurrently.
 * `size` is clamped to at least 1. If any session fails to initialize, the sessions that were
 * already created are torn down before the error is rethrown, so a partial pool is never leaked.
 */
export async function createBrowserPool(
  size: number,
  createBrowser: () => Promise<Browser>,
  options: BrowserPoolOptions = {},
): Promise<BrowserPool> {
  const count = Math.max(1, Math.floor(size))
  const recycleAfterStories = options.recycleAfterStories ?? 0
  const maxConsecutiveInfraFailures = options.maxConsecutiveInfraFailures ?? 0

  const created: Browser[] = []
  try {
    await Promise.all(
      Array.from({ length: count }, async () => {
        const browser = await createBrowser()
        created.push(browser)
      }),
    )
  } catch (err) {
    // Tear down any sessions that did come up so a failed pool init doesn't leak Chrome processes.
    await Promise.all(created.map((browser) => browser.deleteSession().catch(() => undefined)))
    throw err
  }

  const sessions: PooledSession[] = created.map((browser, id) => ({
    id,
    browser,
    storiesRendered: 0,
    consecutiveInfraFailures: 0,
  }))
  const available: PooledSession[] = [...sessions]
  const waiters: Array<(session: PooledSession) => void> = []
  let sessionInit: ((browser: Browser) => Promise<void>) | undefined

  async function replace(session: PooledSession, reason: string): Promise<void> {
    log.info(
      { sessionId: session.id, reason, storiesRendered: session.storiesRendered },
      `browserPool: replacing session ${session.id} (${reason})`,
    )
    await bestEffortDeleteSession(session.browser, reason)

    // Create the replacement browser (the factory reinstalls the per-session safeguards and the
    // render-state hook), retrying once before giving up.
    let browser: Browser
    try {
      browser = await createBrowser()
    } catch (err) {
      log.warn(err, `browserPool: failed to create replacement session (${reason}); retrying once`)
      browser = await createBrowser()
    }
    if (sessionInit) {
      await sessionInit(browser)
    }

    session.browser = browser
    session.storiesRendered = 0
    session.consecutiveInfraFailures = 0
  }

  return {
    size: sessions.length,
    sessions,
    acquire(): Promise<PooledSession> {
      const next = available.shift()
      if (next != undefined) {
        return Promise.resolve(next)
      }
      return new Promise<PooledSession>((resolve) => waiters.push(resolve))
    },
    async release(session: PooledSession): Promise<void> {
      // Replace a condemned session BEFORE waking the next waiter, so a waiter never receives a
      // session that is dead (consecutive infra failures) or due for recycling (issue #453).
      try {
        if (recycleAfterStories > 0 && session.storiesRendered >= recycleAfterStories) {
          await replace(session, "recycle")
        } else if (
          maxConsecutiveInfraFailures > 0 &&
          session.consecutiveInfraFailures >= maxConsecutiveInfraFailures
        ) {
          await replace(session, "infra-failures")
        }
      } catch (err) {
        // Replacement failed (browser creation failed twice). Return the slot anyway: the next
        // renderer probes the session before use and will attempt another replacement, so the
        // pool self-heals instead of deadlocking a waiter here.
        log.error(err, `browserPool: failed to replace session ${session.id} on release`)
      }
      const waiter = waiters.shift()
      if (waiter != undefined) {
        waiter(session)
      } else {
        available.push(session)
      }
    },
    replace,
    setSessionInit(init: (browser: Browser) => Promise<void>): void {
      sessionInit = init
    },
    async destroyAll(): Promise<void> {
      await Promise.all(
        sessions.map((session) =>
          session.browser.deleteSession().catch((err: unknown) => {
            log.debug(
              err,
              "browserPool: deleteSession during teardown failed (may already be closed)",
            )
          }),
        ),
      )
    },
  }
}
