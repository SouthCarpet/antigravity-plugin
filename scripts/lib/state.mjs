/**
 * Job state persistence. Stores job metadata and results in a workspace-specific
 * directory tree.
 *
 * Directory layout:
 *   <stateRoot>/<slug>-<hash>/
 *     state.json        — global config + job index
 *     jobs/
 *       <job-id>.json   — full job record
 *       <job-id>.log    — timestamped progress log
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { recoverWorkspaceMutex, withWorkspaceMutex, withWorkspaceMutexSync, writeJsonAtomic } from "./atomic-state.mjs";
import { assertPrivateDir } from "./fs.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENVS = ["CLAUDE_PLUGIN_DATA", "CODEX_PLUGIN_DATA", "AGY_PLUGIN_DATA"];
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "antigravity");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const JOB_STATUSES = new Set(["queued", "running", ...TERMINAL_STATUSES]);

function slugify(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function hashPath(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

/**
 * Resolve the host-owned state root. Claude retains first priority for
 * backward compatibility if a caller unusually supplies multiple host vars.
 * Standalone use (no host variable) is documented to use the OS temp root.
 */
export function resolveStateRoot(env = process.env) {
  for (const name of PLUGIN_DATA_ENVS) {
    if (env[name]) return { root: path.join(env[name], "state"), source: name };
  }
  return { root: FALLBACK_STATE_ROOT_DIR, source: "standalone-temp" };
}

/**
 * Resolve the state directory for a workspace. `cwd` must already be the
 * resolved workspace root (076-T6 R4) — callers resolve it once via
 * `resolveWorkspaceRoot` and pass it down; this function no longer
 * re-resolves it, so a status snapshot over several stored jobs spawns at
 * most the one `git` call its caller already made, not one per state
 * access.
 *
 * @param {string} cwd the resolved workspace root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveStateDir(cwd, env = process.env) {
  const root = String(cwd);
  const slug = slugify(path.basename(root));
  const hash = hashPath(root);
  const leaf = `${slug}-${hash}`;
  const selected = resolveStateRoot(env);
  const preferred = path.join(selected.root, leaf);

  // Before Codex/agy host roots were recognized, those hosts wrote to the
  // standalone temp root. Keep using an existing legacy workspace directory
  // until it is explicitly moved, so upgrades do not make old jobs vanish.
  if (selected.source !== "CLAUDE_PLUGIN_DATA" && selected.source !== "standalone-temp") {
    const legacy = path.join(FALLBACK_STATE_ROOT_DIR, leaf);
    if (!fs.existsSync(preferred) && fs.existsSync(legacy)) return legacy;
  }
  return preferred;
}

/** @param {string} cwd the resolved workspace root @returns {string} */
export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

/** @param {string} cwd the resolved workspace root @returns {string} */
export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

/** @param {string} cwd the resolved workspace root @param {string} jobId @returns {string} */
export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

/** @param {string} cwd the resolved workspace root @param {string} jobId @returns {string} */
export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

/** @param {string} cwd the resolved workspace root @returns {void} */
export function ensureStateDir(cwd) {
  const dir = resolveJobsDir(cwd);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDir(dir);
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {number[]} ownerPids
 * @returns {boolean} true when a lock owned by one of `ownerPids` was reaped
 */
export function recoverStateLock(cwd, ownerPids) {
  return recoverWorkspaceMutex(resolveStateDir(cwd), ownerPids);
}

/**
 * Validate persisted jobs without rejecting legacy records or extra fields.
 *
 * @param {unknown} record
 * @returns {record is import('./types.mjs').JobRecord}
 */
export function validateJobRecord(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record) &&
    typeof record.id === "string" && /^[a-f0-9]{12}$/.test(record.id) &&
    JOB_STATUSES.has(record.status) &&
    ["pid", "workerPid", "agyPid"].every((field) =>
      !Object.hasOwn(record, field) || record[field] === null ||
      (Number.isInteger(record[field]) && record[field] > 0));
}

function readStateIndex(cwd) {
  const parsed = JSON.parse(fs.readFileSync(resolveStateFile(cwd), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) {
    throw new SyntaxError("Invalid state index shape");
  }
  return {
    ...defaultState(),
    ...parsed,
    config: { ...defaultState().config, ...(parsed.config ?? {}) },
  };
}

function jobIndexProjection(job) {
  const { request, result, stdout, ...index } = job;
  return index;
}

function rebuildStateIndex(cwd) {
  const jobs = [];
  let skipped = 0;
  let names;
  try {
    names = fs.readdirSync(resolveJobsDir(cwd));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    names = [];
  }
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const job = readJobFile(cwd, name.slice(0, -5));
    if (!validateJobRecord(job) || name !== `${job.id}.json`) {
      skipped += 1;
      continue;
    }
    jobs.push(jobIndexProjection(job));
  }
  return { state: { ...defaultState(), jobs }, skipped };
}

// Only called while the workspace mutex is held. Re-read after acquisition:
// another writer may already have repaired or replaced the index.
function loadStateUnlocked(cwd) {
  let failure;
  try {
    return readStateIndex(cwd);
  } catch (error) {
    failure = error;
  }

  let damagedName = null;
  if (failure.code !== "ENOENT") {
    let timestamp = Date.now();
    do {
      damagedName = `${STATE_FILE_NAME}.corrupt-${new Date(timestamp++).toISOString().replace(/:/g, "-")}`;
    } while (fs.existsSync(path.join(resolveStateDir(cwd), damagedName)));
    // If quarantine fails, reject; never overwrite the only damaged copy.
    fs.renameSync(resolveStateFile(cwd), path.join(resolveStateDir(cwd), damagedName));
  }
  const { state, skipped } = rebuildStateIndex(cwd);
  if (damagedName || state.jobs.length > 0 || skipped > 0) {
    ensureStateDir(cwd);
    writeJsonAtomic(resolveStateFile(cwd), state);
  }
  if (damagedName) {
    process.stderr.write(
      `antigravity: state index was unreadable; rebuilt from ${state.jobs.length} job files ` +
      `(damaged copy kept as ${damagedName})` +
      (skipped ? `; skipped ${skipped} invalid job files` : "") + "\n",
    );
  }
  return state;
}

/**
 * @param {string} cwd the resolved workspace root
 * @returns {{ version: number, config: { stopReviewGate: boolean }, jobs: import('./types.mjs').JobIndexEntry[] }}
 */
export function loadState(cwd) {
  try {
    return readStateIndex(cwd);
  } catch {
    return withWorkspaceMutexSync(resolveStateDir(cwd), () => loadStateUnlocked(cwd));
  }
}

function pruneJobs(jobs) {
  let terminalCount = 0;
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .filter((job) => !TERMINAL_STATUSES.has(job.status) || ++terminalCount <= MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Reconcile a caller-supplied state snapshot with the current on-disk state.
 *
 * Rules:
 * - Jobs from the current on-disk state are preserved (so a stale caller
 *   snapshot cannot silently drop another writer's in-flight job).
 * - Jobs in the incoming snapshot overwrite fields for matching ids.
 * - Terminal history is capped to MAX_JOBS by most-recent `updatedAt`.
 *   Active jobs are retained regardless of age.
 */
function reconcileState(current, incoming) {
  const byId = new Map();
  for (const job of current.jobs ?? []) {
    if (job && job.id) byId.set(job.id, job);
  }
  for (const job of incoming?.jobs ?? []) {
    if (!job || !job.id) continue;
    const prev = byId.get(job.id);
    byId.set(job.id, prev ? { ...prev, ...job } : job);
  }
  const cappedJobs = pruneJobs(Array.from(byId.values()));

  return {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(current.config ?? {}),
      ...(incoming?.config ?? {})
    },
    jobs: cappedJobs
  };
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  // Re-load current on-disk state inside the mutex so we reconcile against
  // the freshest snapshot and never unlink another writer's files.
  const current = loadStateUnlocked(cwd);
  const nextState = reconcileState(current, state);

  writeJsonAtomic(resolveStateFile(cwd), nextState);

  // Prune job artifacts only for jobs that were dropped by reconciliation
  // (i.e. the MAX_JOBS cap). Jobs absent from the caller's snapshot but
  // still present in `current` are retained by `reconcileState`, so they
  // will survive here.
  const retainedIds = new Set(nextState.jobs.map((j) => j.id));
  for (const prevJob of [...(current.jobs ?? []), ...(state.jobs ?? [])]) {
    if (TERMINAL_STATUSES.has(prevJob.status) && !retainedIds.has(prevJob.id)) {
      removeFileIfExists(resolveJobFile(cwd, prevJob.id));
      removeFileIfExists(resolveJobLogFile(cwd, prevJob.id));
    }
  }
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {{ config?: object, jobs?: import('./types.mjs').JobIndexEntry[] }} state
 * @returns {Promise<void>}
 */
export async function saveState(cwd, state) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    saveStateUnlocked(cwd, state);
  });
}

/** @param {string} cwd the resolved workspace root @returns {{ stopReviewGate: boolean }} */
export function getConfig(cwd) {
  return loadState(cwd).config;
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {object} patch
 * @returns {Promise<void>}
 */
export async function setConfig(cwd, patch) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    const state = loadStateUnlocked(cwd);
    state.config = { ...state.config, ...patch };
    saveStateUnlocked(cwd, state);
  });
}

/** @param {string} cwd the resolved workspace root @returns {import('./types.mjs').JobIndexEntry[]} */
export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {import('./types.mjs').JobIndexEntry} job
 * @returns {Promise<void>}
 */
export async function upsertJob(cwd, job) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    upsertJobUnlocked(cwd, job);
  });
}

function upsertJobUnlocked(cwd, job) {
  const state = loadStateUnlocked(cwd);
  const index = state.jobs.findIndex((j) => j.id === job.id);
  const now = new Date().toISOString();
  const updated = { ...job, updatedAt: now };

  if (index >= 0) state.jobs[index] = { ...state.jobs[index], ...updated };
  else state.jobs.push({ ...updated, createdAt: now });

  saveStateUnlocked(cwd, state);
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {string} jobId
 * @returns {import('./types.mjs').JobRecord | null}
 */
export function readJobFile(cwd, jobId) {
  const filePath = resolveJobFile(cwd, jobId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Internal atomic write. Callers are responsible for holding the per-job
 * mutex; exposed so higher-level helpers that already hold the mutex (e.g.
 * `recordJobEvent`) can persist without re-acquiring.
 *
 * @param {string} cwd the resolved workspace root
 * @param {string} jobId
 * @param {import('./types.mjs').JobRecord} data
 * @returns {void}
 */
export function writeJobFileUnlocked(cwd, jobId, data) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, jobId);
  writeJsonAtomic(filePath, data);
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {string} jobId
 * @param {import('./types.mjs').JobRecord} data
 * @returns {Promise<void>}
 */
export async function writeJobFile(cwd, jobId, data) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    writeJobFileUnlocked(cwd, jobId, data);
  });
}

/**
 * Commit the detail first, then its index projection, under one mutex.
 *
 * @param {string} cwd the resolved workspace root
 * @param {string} jobId
 * @param {Partial<import('./types.mjs').JobRecord>} detailPatch
 * @param {Partial<import('./types.mjs').JobIndexEntry>} [indexPatch]
 * @returns {Promise<import('./types.mjs').JobRecord>}
 */
export async function patchJobState(cwd, jobId, detailPatch, indexPatch = detailPatch) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    const existing = readJobFile(cwd, jobId) ?? { id: jobId };
    const merged = { ...existing, ...detailPatch, id: jobId, updatedAt: new Date().toISOString() };
    writeJobFileUnlocked(cwd, jobId, merged);
    upsertJobUnlocked(cwd, { ...jobIndexProjection(merged), ...indexPatch, id: jobId, status: merged.status });
    return merged;
  });
}

/**
 * @param {string} cwd the resolved workspace root
 * @param {string} jobId
 * @param {string} line
 * @returns {void}
 */
export function appendJobLog(cwd, jobId, line) {
  ensureStateDir(cwd);
  const logPath = resolveJobLogFile(cwd, jobId);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
}

const DEFAULT_LOG_TAIL_LINES = 4;
const DEFAULT_LOG_TAIL_MAX_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` from the end of a file and return its last
 * `lines` lines, without ever loading the whole file into memory (076-T6
 * R4/item 20: a `status` snapshot used to read a whole multi-megabyte job
 * log to show four lines). The one log reader for both `job-control.mjs`'s
 * progress tail and any other caller that used to go through the retired
 * `readJobLog(cwd, jobId)` (same bounded-read job, a general file path
 * instead of a job id so `job-control.mjs` can pass its already-resolved
 * `logFile`). Missing file or any read error returns `""`, matching the old
 * `readJobLog` contract.
 *
 * @param {string} filePath absolute path to the log file
 * @param {{ lines?: number, maxBytes?: number }} [options]
 * @returns {string} the tail, newline-joined, oldest kept line first
 */
export function readLogTail(filePath, { lines = DEFAULT_LOG_TAIL_LINES, maxBytes = DEFAULT_LOG_TAIL_MAX_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(fd);
    const readSize = Math.min(size, maxBytes);
    const start = size - readSize;
    const buffer = Buffer.alloc(readSize);
    if (readSize > 0) fs.readSync(fd, buffer, 0, readSize, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      // Started mid-file: the first line is a truncated fragment, drop it.
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return text.trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
}
