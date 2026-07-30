import os from "node:os"

/**
 * Stable identity for this worker instance (issue #451). The hostname is stable across a
 * container restart (Kubernetes pod name / compose container name), unlike the previous
 * `worker-<pid>` scheme, so a restarting worker can recognize — and reclaim — builds and task
 * locks it owned before a crash. Also used as this worker's `worker_status` row id.
 */
export const WORKER_ID: string = os.hostname()
