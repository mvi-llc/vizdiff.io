/**
 * Helpers for naming VCS commit statuses / check runs per project (monorepo support, issue #443).
 *
 * A repository can host multiple VizDiff projects (one per Storybook in a monorepo), each
 * distinguished by an optional `Project.key`. So that concurrent projects report independent
 * statuses on the same commit, the project key is appended to the status context. Projects without
 * a key (the empty-string default, i.e. every pre-existing single-project setup) keep the historic
 * names so nothing changes for them.
 */

/** Base GitLab commit status context. Kept verbatim for projects without a key. */
export const GITLAB_STATUS_CONTEXT_BASE = "vizdiff/visual-tests"

/** Base GitHub check run name. Kept verbatim for projects without a key. */
export const GITHUB_CHECK_RUN_NAME_BASE = "Visual Tests"

/**
 * GitLab commit status context ("name") for a project.
 * `""`/`null`/`undefined` key -> `vizdiff/visual-tests` (backward compatible);
 * otherwise -> `vizdiff/visual-tests/<key>`.
 */
export function gitlabStatusContext(projectKey: string | null | undefined): string {
  return projectKey ? `${GITLAB_STATUS_CONTEXT_BASE}/${projectKey}` : GITLAB_STATUS_CONTEXT_BASE
}

/**
 * GitHub check run name for a project.
 * `""`/`null`/`undefined` key -> `Visual Tests` (backward compatible);
 * otherwise -> `Visual Tests (<key>)`.
 */
export function githubCheckRunName(projectKey: string | null | undefined): string {
  return projectKey ? `${GITHUB_CHECK_RUN_NAME_BASE} (${projectKey})` : GITHUB_CHECK_RUN_NAME_BASE
}

/**
 * Project keys are slug-like: 1-64 chars, starting with an alphanumeric, then alphanumerics,
 * dots, underscores, or dashes. This keeps them safe to embed in commit status contexts, check
 * run names, and URLs.
 */
const PROJECT_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** True if `key` is a valid (non-empty) project key. The empty string is the "no key" default. */
export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_REGEX.test(key)
}
