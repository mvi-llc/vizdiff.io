import { createHash } from "crypto"

/**
 * Canonical S3/MinIO object-key layout, shared by every writer and prefix-computation site
 * (api upload, worker screenshot/diff upload, retention reaper, project/account deletion).
 *
 * Keys carry a two-level `/ab/cd/` hash fanout derived from the project id:
 *
 *   projects/<ab>/<cd>/<projectId>/screenshots/<uploadId>/<storyId>.png
 *   projects/<ab>/<cd>/<projectId>/<uploadId>.tar.gz
 *
 * S3 partitions its index by leading key bytes and rate-limits per partitioned prefix
 * (~3,500 PUT/s). Sequential project ids (and time-ordered UUIDv7 upload ids) would otherwise
 * concentrate all new writes on the rightmost partition; hashing the project segment spreads
 * concurrent projects uniformly across 65,536 buckets so partition splits distribute load.
 * The fanout sits *before* the project id — not at the very front of the key — so that
 * delete-by-prefix still works at every granularity used by the app: per upload
 * ({@link screenshotsKeyPrefix}), per project and per account ({@link projectKeyPrefix}),
 * all computable from ids alone.
 *
 * Within a single project, upload ids are UUIDv7 (time-ordered), capping one project at
 * roughly a single partition's write rate. That is a deliberate trade-off; an inner fanout
 * can be added if a single project ever needs more.
 *
 * TestResult image columns store the full object key, so readers (presigning) never
 * recompute paths from ids — only writers and deleters must agree with this module.
 */

/** Two-level `/ab/cd/` fanout segment for a project id, e.g. `"3f/a2"`. */
function projectHashSegment(projectId: number | string): string {
  const hex = createHash("sha256").update(String(projectId)).digest("hex")
  return `${hex.slice(0, 2)}/${hex.slice(2, 4)}`
}

/** Key prefix holding every object that belongs to a project (#132: delete-by-prefix). */
export function projectKeyPrefix(projectId: number | string): string {
  return `projects/${projectHashSegment(projectId)}/${projectId}/`
}

/** Key of the uploaded Storybook tarball for one upload. */
export function uploadTarballKey(projectId: number | string, uploadId: string): string {
  return `${projectKeyPrefix(projectId)}${uploadId}.tar.gz`
}

/** Key prefix holding every screenshot and diff image for one upload. */
export function screenshotsKeyPrefix(projectId: number | string, uploadId: string): string {
  return `${projectKeyPrefix(projectId)}screenshots/${uploadId}/`
}

/** Key of a captured story screenshot. */
export function screenshotKey(
  projectId: number | string,
  uploadId: string,
  storyId: string,
): string {
  return `${screenshotsKeyPrefix(projectId, uploadId)}${storyId}.png`
}

/** Key of the diff image generated when a story's screenshot differs from the baseline. */
export function diffImageKey(
  projectId: number | string,
  uploadId: string,
  storyId: string,
): string {
  return `${screenshotsKeyPrefix(projectId, uploadId)}${storyId}-diff.png`
}

/**
 * Key of the best-effort failure-time screenshot captured when a story fails (issue #475).
 * Failure context, not a baseline candidate. Lives under {@link screenshotsKeyPrefix}, so
 * upload/project/account retention and delete-by-prefix cover it with no extra bookkeeping.
 */
export function failureScreenshotKey(
  projectId: number | string,
  uploadId: string,
  storyId: string,
): string {
  return `${screenshotsKeyPrefix(projectId, uploadId)}${storyId}-failure.png`
}
