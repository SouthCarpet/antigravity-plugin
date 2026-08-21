/**
 * job-helpers — shared helpers for command modules.
 *
 * Provides job id minting, foreground/background tracking glue, and stdout
 * persistence around `runAgyPrint` / `spawnAgyDetached`. The prompt travels
 * to `agy` over stdin as a single stream-json line, not argv (see
 * agent-runtime.mjs); the response streams back as NDJSON events, and
 * readable text arrives incrementally via `step_update.text_delta` events
 * (surfaced here through the `onText` callback) rather than as one final
 * blob.
 */

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { runAgyPrint, spawnAgyDetached, resolveAgyBin } from "./agent-runtime.mjs";
import {
  appendJobLog,
  resolveJobLogFile,
  upsertJob,
  writeJobFile,
  readJobFile,
} from "./state.mjs";
import { SESSION_ID_ENV } from "./job-control.mjs";

/** Generate a short, URL-safe job id (12 hex chars). */
export function newJobId() {
  return randomBytes(6).toString("hex");
}

/** Resolve the current session id (or `null` if unset). */
export function currentSessionId(env = process.env) {
  return env[SESSION_ID_ENV] ?? null;
}

/**
 * Map a `runAgyPrint` result.status onto a job status persisted on disk.
 *
 * `auth_required` and `timeout` are surfaced as `failed` with a diagnostic
 * `healthStatus` set so the status command can render the OAuth URL.
 */
function deriveJobStatus(result) {
  switch (result.status) {
    case "completed":
      return { status: "completed" };
    case "cancelled":
      return { status: "cancelled" };
    case "auth_required":
      return {
        status: "failed",
        healthStatus: "auth_required",
        healthMessage:
          "Antigravity is not authenticated. Complete the OAuth flow shown above, then re-run.",
        recommendedAction: "Run /antigravity:setup to complete the OAuth flow.",
      };
    case "timeout":
      return {
        status: "failed",
        healthStatus: "failed",
        healthMessage: "agy --print timed out before producing output.",
        recommendedAction: "Re-run the command, optionally with --background.",
      };
    case "failed":
    default:
      return {
        status: "failed",
        healthStatus: "failed",
      };
  }
}

/**
 * Create a tracked job record on disk.
 *
 * Returns the job index entry. The detailed payload (request, result,
 * stdout) lives in the per-job file written via `writeJobFile`.
 */
export async function createTrackedJob({
  workspaceRoot,
  kind,
  title,
  request = null,
  conversationId = null,
  env = process.env,
}) {
  const id = newJobId();
  const now = new Date().toISOString();
  const sessionId = currentSessionId(env);
  const job = {
    id,
    kind,
    title: title ?? null,
    status: "queued",
    phase: "queued",
    sessionId,
    pid: null,
    conversationId,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    logFile: resolveJobLogFile(workspaceRoot, id),
  };
  await upsertJob(workspaceRoot, job);
  await writeJobFile(workspaceRoot, id, {
    ...job,
    request,
    result: null,
  });
  appendJobLog(workspaceRoot, id, `[job] created kind=${kind}`);
  return job;
}

/** Patch and persist a job index + file. */
export async function patchJob(workspaceRoot, jobId, patch) {
  const existing = readJobFile(workspaceRoot, jobId) ?? { id: jobId };
  const merged = { ...existing, ...patch, id: jobId };
  await upsertJob(workspaceRoot, {
    id: jobId,
    ...stripDetail(patch),
  });
  await writeJobFile(workspaceRoot, jobId, merged);
  return merged;
}

/** Strip detail-only fields (request/result/stdout) from a patch destined for the index. */
function stripDetail(patch) {
  const { request: _r, result: _re, stdout: _s, ...rest } = patch;
  return rest;
}

/**
 * Run an agy --print call in the FOREGROUND while tracking it as a job.
 *
 * The job is created with status=queued, transitioned to running, and
 * resolved to completed/failed/cancelled based on the runAgyPrint result.
 *
 * @returns {Promise<{ job: any, result: any }>}
 */
export async function runForegroundJob({
  workspaceRoot,
  kind,
  title,
  prompt,
  mode = "print",
  conversationId,
  addDirs = [],
  model,
  outputFormat,
  extraArgs = [],
  cwd,
  request = null,
  env = process.env,
  onStdout,
  onStderr,
  onText,
} = {}) {
  const job = await createTrackedJob({
    workspaceRoot,
    kind,
    title,
    request,
    conversationId,
    env,
  });

  const startedAt = new Date().toISOString();
  await patchJob(workspaceRoot, job.id, {
    status: "running",
    phase: "running",
    startedAt,
    pid: process.pid,
  });
  appendJobLog(workspaceRoot, job.id, `[job] running (foreground) pid=${process.pid}`);

  let result;
  try {
    result = await runAgyPrint({
      prompt,
      mode,
      conversationId,
      addDirs,
      model,
      outputFormat,
      extraArgs,
      cwd: cwd ?? workspaceRoot,
      env,
      onStdout,
      onStderr,
      onText,
    });
  } catch (err) {
    const completedAt = new Date().toISOString();
    appendJobLog(workspaceRoot, job.id, `[job] crashed: ${err?.message ?? err}`);
    await patchJob(workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      completedAt,
      errorMessage: err?.message ?? String(err),
      healthStatus: "failed",
    });
    throw err;
  }

  const completedAt = new Date().toISOString();
  const derived = deriveJobStatus(result);
  await patchJob(workspaceRoot, job.id, {
    status: derived.status,
    phase: derived.status,
    completedAt,
    exitCode: result.exitCode,
    summary: deriveSummary(result),
    oauthUrl: result.oauthUrl ?? null,
    errorMessage: result.status === "failed" ? trim(result.stderr) : null,
    healthStatus: derived.healthStatus ?? null,
    healthMessage: derived.healthMessage ?? null,
    recommendedAction: derived.recommendedAction ?? null,
    result: {
      rawOutput: result.stdout,
      stderr: result.stderr,
      status: result.status,
      exitCode: result.exitCode,
      oauthUrl: result.oauthUrl ?? null,
      usage: result.usage ?? null,
      durationSeconds: result.durationSeconds ?? null,
    },
  });
  appendJobLog(
    workspaceRoot,
    job.id,
    `[job] ${derived.status} exit=${result.exitCode} status=${result.status}`,
  );
  return { job: { ...job, status: derived.status }, result };
}

/**
 * Resolve the absolute OS filesystem path to the background worker script
 * (scripts/commands/_worker.mjs), for spawning via `node <path> <jobId>`.
 *
 * Uses `fileURLToPath`, NOT `URL.pathname` — on Windows, `.pathname` yields
 * a POSIX-shaped path (`/A:/projects-vault/...`) that does not exist on
 * disk. `spawn` would then launch `node` against a nonexistent file; Node
 * exits `MODULE_NOT_FOUND`, but with `stdio: ['ignore','ignore','ignore']`
 * (see `startBackgroundJob` below) that failure was invisible — the job
 * never left `queued`, and `waitForJob`/`task --wait` hung until timeout
 * (or forever with `timeoutMs: 0`).
 */
export function resolveWorkerPath() {
  return fileURLToPath(new URL("../commands/_worker.mjs", import.meta.url));
}

/**
 * Fire-and-forget a background worker that will run the prompt with the
 * given mode. Returns the queued job index entry.
 *
 * The worker script lives at scripts/commands/_worker.mjs and is invoked as
 * `node <worker.mjs> <jobId>`.
 */
export async function startBackgroundJob({
  workspaceRoot,
  kind,
  title,
  prompt,
  mode = "print",
  conversationId = null,
  addDirs = [],
  cwd,
  request = null,
  env = process.env,
}) {
  const job = await createTrackedJob({
    workspaceRoot,
    kind,
    title,
    request: {
      prompt,
      mode,
      conversationId,
      addDirs,
      cwd: cwd ?? workspaceRoot,
      ...(request ?? {}),
    },
    conversationId,
    env,
  });

  const workerPath = resolveWorkerPath();
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [workerPath, job.id], {
    cwd: workspaceRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...env, [SESSION_ID_ENV]: env[SESSION_ID_ENV] ?? "" },
  });
  child.unref();

  await patchJob(workspaceRoot, job.id, {
    pid: child.pid ?? null,
  });
  appendJobLog(workspaceRoot, job.id, `[job] dispatched worker pid=${child.pid}`);
  return { job, pid: child.pid ?? null };
}

/**
 * Block in the current process until a job reaches a terminal state.
 *
 * Polls at `pollMs` (default 1000ms). Returns the latest job record. Times
 * out after `timeoutMs` (0 = no timeout).
 */
export async function waitForJob(workspaceRoot, jobId, { pollMs = 1000, timeoutMs = 0 } = {}) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  while (true) {
    const job = readJobFile(workspaceRoot, jobId);
    if (job && TERMINAL.has(job.status)) return job;
    if (deadline && Date.now() > deadline) return job ?? null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function deriveSummary(result) {
  if (!result?.stdout) return null;
  const firstLine = result.stdout.split("\n").map((s) => s.trim()).find(Boolean);
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function trim(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Re-export so command modules can pull everything from one place. */
export { runAgyPrint, spawnAgyDetached, resolveAgyBin };
