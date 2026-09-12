/**
 * Job querying, enrichment, and resolution for status/result/cancel commands.
 *
 * Lean port from gemini-plugin-cc — ACP / broker references removed because
 * agy 1.0.1 has no ACP. Health classifier still tracks `auth_required`,
 * `failed`, `worker_missing`, and `cancel_failed` (the signals a writer in
 * this codebase actually persists; `rate_limited` was removed 076-T6 R2 —
 * no writer ever sets it, so `status <id>` could never render it).
 */

import { getConfig, listJobs, readJobFile, readLogTail } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { isProcessAlive } from "./process.mjs";

export const SESSION_ID_ENV = "ANTIGRAVITY_PLUGIN_SESSION_ID";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const QUIET_AFTER_MS = 2 * 60 * 1000;
export const POSSIBLY_STALLED_AFTER_MS = 10 * 60 * 1000;

/** @param {import('./types.mjs').JobIndexEntry[]} jobs @returns {import('./types.mjs').JobIndexEntry[]} */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
}

/**
 * @param {import('./types.mjs').JobIndexEntry[]} jobs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('./types.mjs').JobIndexEntry[]} `jobs` unfiltered when no session id is set
 */
export function filterJobsForCurrentSession(jobs, env = process.env) {
  const sessionId = env[SESSION_ID_ENV] ?? null;
  if (!sessionId) return jobs;
  return jobs.filter((j) => j.sessionId === sessionId);
}

function matchJobReference(jobs, reference, filter) {
  const candidates = filter ? jobs.filter(filter) : jobs;
  if (!reference) return candidates[0] ?? null;

  const exact = candidates.find((j) => j.id === reference);
  if (exact) return exact;

  const partial = candidates.filter((j) => j.id.includes(reference));
  if (partial.length === 1) return partial[0];

  const idx = Number(reference);
  if (Number.isFinite(idx) && idx >= 1 && idx <= candidates.length) {
    return candidates[idx - 1];
  }

  return null;
}

function parseTime(value) {
  const ms = new Date(value ?? "").getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Persisted diagnostic statuses that must survive time-based reclassification
// until an explicit recovery event clears them.
const DIAGNOSTIC_HEALTH_STATUSES = new Set([
  "auth_required",
  "failed",
  "worker_missing",
  "cancel_failed",
]);

/**
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {(pid: number) => boolean} probe
 * @returns {object | null} a health patch, or null when the worker is alive
 */
function classifyWorkerMissing(job, probe) {
  const workerPid = job.workerPid ?? job.pid;
  if (!workerPid || probe(workerPid)) return null;
  return {
    healthStatus: "worker_missing",
    healthMessage: "Worker process is no longer running.",
    recommendedAction:
      "Check /antigravity:result or /antigravity:status, then retry if the result is incomplete.",
  };
}

/**
 * @param {import('./types.mjs').JobIndexEntry} job
 * @returns {object | null} the persisted diagnostic status, or null when none applies
 */
function classifyPersistedDiagnostic(job) {
  if (!DIAGNOSTIC_HEALTH_STATUSES.has(job.healthStatus)) return null;
  return {
    healthStatus: job.healthStatus,
    healthMessage: job.healthMessage ?? null,
    recommendedAction: job.recommendedAction ?? null,
  };
}

/**
 * @param {import('./types.mjs').JobIndexEntry} job
 * @returns {{ heartbeatMs: number | null, lastProgressMs: number | null, lastHeartbeatMs: number | null }}
 */
function computeActivityTimestamps(job) {
  const progressMs = parseTime(job.lastProgressAt) ?? parseTime(job.lastModelOutputAt);
  const heartbeatMs = parseTime(job.lastHeartbeatAt);
  const fallback = progressMs === null && heartbeatMs === null ? parseTime(job.startedAt) : null;
  const lastProgressMs = progressMs ?? fallback;
  const lastHeartbeatMs = heartbeatMs ?? fallback;
  return { heartbeatMs, lastProgressMs, lastHeartbeatMs };
}

/**
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {number} nowMs
 * @param {number | null} lastProgressMs
 * @returns {object | null}
 */
function classifyActive(job, nowMs, lastProgressMs) {
  if (lastProgressMs === null || nowMs - lastProgressMs > QUIET_AFTER_MS) return null;
  return {
    healthStatus: "active",
    healthMessage: job.healthMessage ?? null,
    recommendedAction: job.recommendedAction ?? null,
  };
}

/**
 * @param {number} nowMs
 * @param {number | null} heartbeatMs
 * @param {number | null} lastProgressMs
 * @param {number | null} lastHeartbeatMs
 * @returns {object | null}
 */
function classifyQuiet(nowMs, heartbeatMs, lastProgressMs, lastHeartbeatMs) {
  const lastActivityMs = Math.max(lastHeartbeatMs ?? -Infinity, lastProgressMs ?? -Infinity);
  if (nowMs - lastActivityMs > POSSIBLY_STALLED_AFTER_MS) return null;
  return {
    healthStatus: "quiet",
    healthMessage:
      heartbeatMs !== null ? "Worker heartbeat is recent, but no progress was recorded recently."
        : "The job started or made progress recently; waiting for more output.",
    recommendedAction:
      "Check status again shortly or inspect the detailed job status.",
  };
}

/**
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {number | null} lastProgressMs
 * @param {number | null} lastHeartbeatMs
 * @returns {object | null}
 */
function classifyPossiblyStalled(job, lastProgressMs, lastHeartbeatMs) {
  if (lastProgressMs === null && lastHeartbeatMs === null && job.status !== "running") return null;
  return {
    healthStatus: "possibly_stalled",
    healthMessage: "No recent worker heartbeat or progress was recorded.",
    recommendedAction:
      "Check /antigravity:status or /antigravity:result, then retry if the job does not recover.",
  };
}

function classifyRuntimeHealth(job, options = {}) {
  if (job.status !== "running" && job.status !== "queued") return {};

  const nowMs = parseTime(options.now) ?? Date.now();
  const probe = options.isProcessAlive ?? isProcessAlive;

  const workerMissing = classifyWorkerMissing(job, probe);
  if (workerMissing) return workerMissing;

  const persisted = classifyPersistedDiagnostic(job);
  if (persisted) return persisted;

  const { heartbeatMs, lastProgressMs, lastHeartbeatMs } = computeActivityTimestamps(job);

  const active = classifyActive(job, nowMs, lastProgressMs);
  if (active) return active;

  const quiet = classifyQuiet(nowMs, heartbeatMs, lastProgressMs, lastHeartbeatMs);
  if (quiet) return quiet;

  const possiblyStalled = classifyPossiblyStalled(job, lastProgressMs, lastHeartbeatMs);
  if (possiblyStalled) return possiblyStalled;

  return {};
}

/**
 * Detail is committed first and wins if its index projection is stale.
 *
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {import('./types.mjs').JobRecord | null | undefined} storedJob
 * @returns {import('./types.mjs').JobIndexEntry | import('./types.mjs').JobRecord}
 */
export function mergeJobDetail(job, storedJob) {
  return storedJob && typeof storedJob === "object" && !Array.isArray(storedJob) && storedJob.id === job.id
    ? { ...job, ...storedJob }
    : job;
}

/**
 * The `deniedActions`/`deniedActionsCount` projection carried through
 * enrichment (plan 085 T2): `enrichJob` drops the nested `result` object
 * below, so these top-level job fields (job-helpers.mjs persists both as
 * job fields, not only inside `result`) are what a status view reads.
 * Split out to keep `enrichJob` itself under the complexity ceiling.
 *
 * @param {import('./types.mjs').JobRecord} source
 * @returns {{ deniedActions: import('./types.mjs').DeniedAction[] | null, deniedActionsCount: number }}
 */
function deniedActionsProjection(source) {
  return {
    deniedActions: source.deniedActions ?? null,
    deniedActionsCount: source.deniedActionsCount ?? 0,
  };
}

/**
 * The `agyPrintTimeout` projection carried through enrichment (plan 086 T1):
 * split out for the same reason {@link deniedActionsProjection} is — one
 * fewer branch inline in `enrichJob` keeps it under the complexity ceiling.
 *
 * @param {import('./types.mjs').JobRecord} source
 * @returns {{ agyPrintTimeout: import('./types.mjs').AgyPrintTimeout | null }}
 */
function printTimeoutProjection(source) {
  return { agyPrintTimeout: source.agyPrintTimeout ?? null };
}

/**
 * The `agyConversationId` projection carried through enrichment (plan 086
 * T5k F1 item 1): split out for the same reason {@link deniedActionsProjection}
 * is — one fewer branch inline in `enrichJob` keeps it under the complexity
 * ceiling. Distinct from the `conversationId` field `enrichJob` still sets
 * inline: that is the id the *caller* passed in via `--conversation`; this
 * is the id agy itself reported, present whenever agy reported one —
 * including on a failed or denied run.
 *
 * @param {import('./types.mjs').JobRecord} source
 * @returns {{ agyConversationId: string | null }}
 */
function agyConversationIdProjection(source) {
  return { agyConversationId: source.agyConversationId ?? null };
}

/**
 * @param {string} workspaceRoot the resolved workspace root
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {{ maxProgressLines?: number, now?: number, isProcessAlive?: typeof isProcessAlive }} [options]
 * @returns {import('./types.mjs').JobRecord}
 */
function enrichJob(workspaceRoot, job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const storedJob = readJobFile(workspaceRoot, job.id);
  const source = mergeJobDetail(job, storedJob);
  const elapsed = computeElapsed(source, options.now);
  const runtimeHealth = classifyRuntimeHealth(source, options);

  const enriched = {
    ...source,
    request: undefined,
    result: undefined,
    rendered: undefined,
    elapsed,
    conversationId: source.conversationId ?? null,
    summary: source.summary ?? null,
    errorMessage: source.errorMessage ?? null,
    healthStatus: runtimeHealth.healthStatus ?? source.healthStatus ?? null,
    healthMessage: runtimeHealth.healthMessage ?? source.healthMessage ?? null,
    recommendedAction:
      runtimeHealth.recommendedAction ?? source.recommendedAction ?? null,
    oauthUrl: source.oauthUrl ?? null,
    ...printTimeoutProjection(source),
    ...agyConversationIdProjection(source),
    ...deniedActionsProjection(source),
    lastHeartbeatAt: source.lastHeartbeatAt ?? null,
    lastProgressAt: source.lastProgressAt ?? null,
    lastModelOutputAt: source.lastModelOutputAt ?? null,
    lastDiagnosticAt: source.lastDiagnosticAt ?? null,
  };

  if (source?.logFile) {
    const tail = readLogTail(source.logFile, { lines: maxProgressLines });
    enriched.recentProgress = tail ? tail.split("\n") : [];
  }

  return enriched;
}

function computeElapsed(job, now = new Date().toISOString()) {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? now;
  if (!start) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return null; // clock skew or bad data
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

/**
 * @param {string} cwd unresolved cwd; resolved once here and passed to every
 *   downstream `state.mjs` call (076-T6 R4)
 * @param {{ env?: NodeJS.ProcessEnv, maxJobs?: number, maxProgressLines?: number,
 *   now?: number, isProcessAlive?: typeof isProcessAlive }} [options]
 * @returns {{ workspaceRoot: string, config: object,
 *   running: import('./types.mjs').JobRecord[], latestFinished: import('./types.mjs').JobIndexEntry | null,
 *   recent: import('./types.mjs').JobIndexEntry[], needsReview: boolean }}
 */
export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const allJobs = sortJobsNewestFirst(listJobs(workspaceRoot)
    .map((job) => mergeJobDetail(job, readJobFile(workspaceRoot, job.id))));
  const sessionJobs = filterJobsForCurrentSession(allJobs, options.env);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;

  const running = sessionJobs
    .filter((j) => j.status === "running" || j.status === "queued")
    .map((j) =>
      enrichJob(workspaceRoot, j, {
        maxProgressLines: options.maxProgressLines,
        now: options.now,
        isProcessAlive: options.isProcessAlive,
      })
    );
  const recent = sessionJobs
    .filter((j) => j.status !== "running" && j.status !== "queued")
    .slice(0, maxJobs);
  const latestFinished = recent[0] ?? null;

  return {
    workspaceRoot,
    config,
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate),
  };
}

/**
 * @param {string} cwd unresolved cwd; resolved once here and passed to every
 *   downstream `state.mjs` call (076-T6 R4)
 * @param {string | null} reference job id, unique prefix, or 1-based index
 * @param {{ maxProgressLines?: number, now?: number, isProcessAlive?: typeof isProcessAlive }} [options]
 * @returns {{ workspaceRoot: string, job: import('./types.mjs').JobRecord }}
 */
export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(
      `No job found for "${reference}". Run /antigravity:status to inspect known jobs.`
    );
  }

  return {
    workspaceRoot,
    job: enrichJob(workspaceRoot, selected, {
      maxProgressLines: options.maxProgressLines,
      now: options.now,
      isProcessAlive: options.isProcessAlive,
    }),
  };
}

/**
 * @param {string} cwd unresolved cwd; resolved once here
 * @param {string | null} reference
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ workspaceRoot: string, job: import('./types.mjs').JobIndexEntry }}
 */
export function resolveResultJob(cwd, reference, env = process.env) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobsWithDetails = listJobs(workspaceRoot)
    .map((job) => mergeJobDetail(job, readJobFile(workspaceRoot, job.id)));
  const jobs = sortJobsNewestFirst(
    reference
      ? jobsWithDetails
      : filterJobsForCurrentSession(jobsWithDetails, env)
  );
  const selected = matchJobReference(
    jobs,
    reference,
    (job) =>
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) return { workspaceRoot, job: selected };

  const active = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "running" || job.status === "queued"
  );
  if (active) {
    throw new Error(
      `Job ${active.id} is still ${active.status}. Run /antigravity:status ${active.id} ` +
        `to check progress, or /antigravity:status ${active.id} --wait to wait.`
    );
  }

  if (reference) {
    throw new Error(
      `No job found for "${reference}". Run /antigravity:status to inspect active jobs.`
    );
  }

  throw new Error("No finished antigravity jobs found for this repository yet.");
}

/**
 * @param {string} cwd unresolved cwd; resolved once here
 * @param {string | null} reference
 * @returns {{ workspaceRoot: string, job: import('./types.mjs').JobIndexEntry }}
 */
export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter(
    (job) => job.status === "running" || job.status === "queued"
  );

  if (activeJobs.length === 0) {
    throw new Error("No active antigravity jobs to cancel.");
  }

  const selected = matchJobReference(activeJobs, reference);
  if (!selected) {
    const ids = activeJobs.map((j) => j.id).join(", ");
    throw new Error(`No active job matched "${reference}". Active jobs: ${ids}`);
  }

  return { workspaceRoot, job: selected };
}
