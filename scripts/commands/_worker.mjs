#!/usr/bin/env node
/**
 * Internal background worker. Not exposed via bin/antigravity.mjs.
 *
 * Invoked by job-helpers.startBackgroundJob as:
 *   node scripts/commands/_worker.mjs <jobId> <workspaceRoot>
 *
 * `<workspaceRoot>` is the exact spelling the parent process used for every
 * state access when it created the job (085-T4 F1 fix round 2): the parent
 * and this worker must key state with the same string, since `resolveStateDir`
 * only falls back to a pre-085 logical-keyed leaf for the caller that spells
 * the workspace the way that leaf was written, and this worker's own
 * `process.cwd()` is already the physical path (a `chdir`'d process's
 * `getcwd()` per POSIX). A missing or non-absolute argument falls back to
 * resolving from `process.cwd()`, matching pre-fix behaviour for a job
 * spawned by an older parent.
 *
 * Reads the job file for <jobId> from the resolved workspace state, runs
 * `agy` per the persisted request (prompt travels over stdin as a
 * stream-json line, not argv — see agent-runtime.mjs), and updates the job
 * record on completion. Appends readable model text to the per-job log
 * file as it streams in, via runAgyPrint's `onText` callback (fired per
 * `step_update.text_delta`) — not the raw NDJSON event stream.
 */

import path from "node:path";

import { appendJobLog, readJobFile, resolveJobLogFile } from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runAgyPrint } from "../lib/agent-runtime.mjs";
import {
  AGY_EFFORTS,
  AGY_MODES,
  DEFAULT_AGY_TIMEOUT_MS,
  applyDenialHint,
  buildStoredResult,
  deriveAnswerSize,
  deriveJobStatus,
  deriveSummary,
  patchJob,
  trim,
} from "../lib/job-helpers.mjs";
import { createJobActivityRecorder } from "../lib/job-activity.mjs";

function unsupportedStoredFlag(extraArgs) {
  if (!Array.isArray(extraArgs)) return String(extraArgs);
  if (extraArgs.length === 0) return null;
  if (extraArgs[0] !== "--mode" || !AGY_MODES.includes(extraArgs[1])) return String(extraArgs[0]);
  return extraArgs.length === 2 ? null : String(extraArgs[2]);
}

/**
 * Neutralise control characters in a value about to be echoed into an error
 * message (item 3: the worker's own revalidation failure text).
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeEchoedValue(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Revalidate a stored `request.effort` against {@link AGY_EFFORTS} before
 * running: a legacy or hand-edited job file is not guaranteed to carry a
 * value the CLI parser would have accepted. Returns `null` when the field is
 * absent or valid, else the sanitized value for the failure message.
 *
 * @param {unknown} effort
 * @returns {string | null}
 */
function unsupportedStoredEffort(effort) {
  if (effort === undefined || effort === null || effort === "") return null;
  if (AGY_EFFORTS.includes(String(effort))) return null;
  return sanitizeEchoedValue(effort);
}

/**
 * Read the job file for `jobId` and its request/prompt. Exits the process
 * (matching the pre-split behaviour) when the job file or its prompt is
 * missing, so this never returns in either case.
 *
 * @param {string} jobId
 * @param {string} workspaceRoot
 * @returns {Promise<{ stored: object, request: object, prompt: string }>}
 */
async function loadWorkerContext(jobId, workspaceRoot) {
  const stored = readJobFile(workspaceRoot, jobId);
  if (!stored) {
    process.stderr.write(`worker: no job file for ${jobId}\n`);
    process.exit(2);
  }
  const request = stored.request ?? {};
  const prompt = request.prompt;
  if (!prompt) {
    await patchJob(workspaceRoot, jobId, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: "worker: missing prompt in job request",
      healthStatus: "failed",
    });
    process.exit(1);
  }
  return { stored, request, prompt };
}

/**
 * @param {ReturnType<typeof createJobActivityRecorder>} activity
 * @param {string} logPath
 * @param {typeof import('node:fs')} fs
 * @returns {(delta: string) => void}
 */
function createWorkerTextLogger(activity, logPath, fs) {
  return (delta) => {
    activity.onText();
    try {
      fs.appendFileSync(logPath, delta, { encoding: "utf8", mode: 0o600 });
    } catch {
      // best-effort log capture
    }
  };
}

/**
 * Run the stored request through `runAgyPrint`, publishing startup once agy
 * spawns and recording a failure on the job if the run throws.
 *
 * @returns {Promise<{ failed: true } | { failed: false, result: import('../lib/types.mjs').RuntimeResult }>}
 */
async function runWorkerAgy({ workspaceRoot, jobId, request, prompt, startedAt, onText, activity }) {
  try {
    const extraArgs = request.extraArgs === undefined ? [] : request.extraArgs;
    const flag = unsupportedStoredFlag(extraArgs);
    if (flag !== null) {
      throw new Error(`stored request carries an unsupported agy flag: ${flag}`);
    }
    const badEffort = unsupportedStoredEffort(request.effort);
    if (badEffort !== null) {
      throw new Error(`stored request carries an unsupported effort: ${badEffort}`);
    }
    const result = await runAgyPrint({
      prompt,
      mode: request.mode ?? "print",
      conversationId: request.conversationId,
      addDirs: request.addDirs ?? [],
      model: request.model,
      effort: request.effort,
      extraArgs,
      cwd: request.cwd ?? workspaceRoot,
      timeoutMs: request.timeoutMs ?? DEFAULT_AGY_TIMEOUT_MS,
      onText,
      onSpawn: async ({ pid }) => {
        // Publish startup in one transaction after the child exists. The
        // previous pre-spawn patch made a just-started worker own the state
        // lock before it could log or launch agy, enlarging the exact window
        // in which an immediate cancellation can kill the lock owner.
        await patchJob(workspaceRoot, jobId, {
          status: "running",
          phase: "running",
          startedAt,
          pid: process.pid,
          workerPid: process.pid,
          agyPid: pid ?? null,
        });
        appendJobLog(workspaceRoot, jobId, `[worker] agy spawned pid=${pid ?? "unknown"}`);
      },
    });
    await activity.finish();
    return { failed: false, result };
  } catch (err) {
    await activity.finish().catch(() => {});
    appendJobLog(workspaceRoot, jobId, `[worker] error: ${err?.message ?? err}`);
    await patchJob(workspaceRoot, jobId, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: err?.message ?? String(err),
      healthStatus: "failed",
    });
    return { failed: true };
  } finally {
    await activity.finish();
  }
}

/**
 * One stored-result projection for both paths (076-T6 R1): the same status
 * mapping, summary derivation, and trimming helper `runForegroundJob` uses,
 * so a background run stores `agyConversationId` and the same timeout retry
 * hint the foreground path already had.
 *
 * @returns {Promise<number>} the worker's process exit code
 */
async function persistWorkerResult(workspaceRoot, jobId, stored, result) {
  applyDenialHint(result, stored.kind);
  const derived = deriveJobStatus(result, stored.kind);
  const { answerBytes, answerLines } = deriveAnswerSize(result.stdout);

  await patchJob(workspaceRoot, jobId, {
    status: derived.status,
    phase: derived.status,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    summary: deriveSummary(result),
    oauthUrl: result.oauthUrl ?? null,
    healthStatus: derived.healthStatus ?? null,
    healthMessage: derived.healthMessage ?? null,
    recommendedAction: derived.recommendedAction ?? null,
    answerBytes,
    answerLines,
    deniedActions: result.deniedActions ?? null,
    deniedActionsCount: Array.isArray(result.deniedActions) ? result.deniedActions.length : 0,
    // Fix round 1 F3: keyed off the raw `result.status` this dropped agy's
    // stderr for `auth_required`/`timeout` jobs, since neither raw status is
    // literally "failed" (only `derived.status`, job-helpers.mjs's mapping
    // of both onto a persisted job status, is). `derived.status === "failed"`
    // restores the pre-T6 behaviour for every status this fallback applies
    // to; `result.errorMessage` (set for a timeout/output-limit termination)
    // still wins when present.
    errorMessage: result.errorMessage ?? (derived.status === "failed" ? trim(result.stderr) : null),
    result: buildStoredResult(result),
  });
  // Fix round 1 F5: pre-T6 this line read `[worker] ${status} exit=${result.exitCode}`
  // with no ` status=` suffix; nothing reads that suffix as a structured
  // field (it only ever surfaced verbatim in `status`'s Recent Progress), so
  // restore the exact pre-T6 wording rather than declare an undeclared change.
  appendJobLog(workspaceRoot, jobId, `[worker] ${derived.status} exit=${result.exitCode}`);
  return derived.status === "completed" ? 0 : 1;
}

async function main() {
  const [jobId, rootArg] = process.argv.slice(2);
  if (!jobId) {
    process.stderr.write("worker: missing jobId\n");
    process.exit(2);
  }

  const workspaceRoot = typeof rootArg === "string" && rootArg !== "" && path.isAbsolute(rootArg)
    ? rootArg
    : resolveWorkspaceRoot(process.cwd());
  const { stored, request, prompt } = await loadWorkerContext(jobId, workspaceRoot);

  const startedAt = new Date().toISOString();
  appendJobLog(workspaceRoot, jobId, `[worker] started pid=${process.pid}`);

  const logPath = resolveJobLogFile(workspaceRoot, jobId);
  const fs = await import("node:fs");
  const activity = createJobActivityRecorder(workspaceRoot, jobId, { heartbeat: true });
  const onText = createWorkerTextLogger(activity, logPath, fs);

  const outcome = await runWorkerAgy({ workspaceRoot, jobId, request, prompt, startedAt, onText, activity });
  if (outcome.failed) return 1;

  return persistWorkerResult(workspaceRoot, jobId, stored, outcome.result);
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`worker: fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
