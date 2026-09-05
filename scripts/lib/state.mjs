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
import { resolveWorkspaceRoot } from "./workspace.mjs";

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

export function resolveStateDir(cwd, env = process.env) {
  const root = resolveWorkspaceRoot(cwd);
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

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

// The trust check (item 15) must cover every directory this plugin creates
// on the way down to `jobs`, not only the leaf: `mkdirSync({ recursive: true })`
// silently accepts a pre-existing state root or per-workspace directory that
// another local user planted, and only ever sets the mode of the directory
// it actually creates. `stateDir`'s parent is the state root regardless of
// whether `resolveStateDir` picked the preferred or the legacy path, since
// both are `<root>/<leaf>`.
export function ensureStateDir(cwd) {
  const stateDir = resolveStateDir(cwd);
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  const stateRoot = path.dirname(stateDir);
  for (const dir of [stateRoot, stateDir, jobsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivateDir(dir);
  }
  return jobsDir;
}

export function recoverStateLock(cwd, ownerPids) {
  return recoverWorkspaceMutex(resolveStateDir(cwd), ownerPids);
}

/** Validate persisted jobs without rejecting legacy records or extra fields. */
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

export async function saveState(cwd, state) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    saveStateUnlocked(cwd, state);
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export async function setConfig(cwd, patch) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    const state = loadStateUnlocked(cwd);
    state.config = { ...state.config, ...patch };
    saveStateUnlocked(cwd, state);
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

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
 */
export function writeJobFileUnlocked(cwd, jobId, data) {
  ensureStateDir(cwd);
  const filePath = resolveJobFile(cwd, jobId);
  writeJsonAtomic(filePath, data);
}

export async function writeJobFile(cwd, jobId, data) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    writeJobFileUnlocked(cwd, jobId, data);
  });
}

/** Commit the detail first, then its index projection, under one mutex. */
export async function patchJobState(cwd, jobId, detailPatch, indexPatch = detailPatch) {
  return withWorkspaceMutex(resolveStateDir(cwd), () => {
    const existing = readJobFile(cwd, jobId) ?? { id: jobId };
    const merged = { ...existing, ...detailPatch, id: jobId, updatedAt: new Date().toISOString() };
    writeJobFileUnlocked(cwd, jobId, merged);
    upsertJobUnlocked(cwd, { ...jobIndexProjection(merged), ...indexPatch, id: jobId, status: merged.status });
    return merged;
  });
}

export function appendJobLog(cwd, jobId, line) {
  ensureStateDir(cwd);
  const logPath = resolveJobLogFile(cwd, jobId);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logPath, `[${timestamp}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readJobLog(cwd, jobId) {
  const logPath = resolveJobLogFile(cwd, jobId);
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}
