#!/usr/bin/env node
/**
 * Internal background worker. Not exposed via bin/antigravity.mjs.
 *
 * Invoked by job-helpers.startBackgroundJob as:
 *   node scripts/commands/_worker.mjs <jobId>
 *
 * Reads the job file for <jobId> from the resolved workspace state, runs
 * `agy` per the persisted request (prompt travels over stdin as a
 * stream-json line, not argv — see agent-runtime.mjs), and updates the job
 * record on completion. Appends readable model text to the per-job log
 * file as it streams in, via runAgyPrint's `onText` callback (fired per
 * `step_update.text_delta`) — not the raw NDJSON event stream.
 */

import { appendJobLog, readJobFile, resolveJobLogFile } from "../lib/state.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runAgyPrint } from "../lib/agent-runtime.mjs";
import {
  AGY_MODES,
  DEFAULT_AGY_TIMEOUT_MS,
  applyDenialHint,
  buildStoredResult,
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

async function main() {
  const [jobId] = process.argv.slice(2);
  if (!jobId) {
    process.stderr.write("worker: missing jobId\n");
    process.exit(2);
  }

  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
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

  const startedAt = new Date().toISOString();
  appendJobLog(workspaceRoot, jobId, `[worker] started pid=${process.pid}`);

  const logPath = resolveJobLogFile(workspaceRoot, jobId);
  const fs = await import("node:fs");
  const activity = createJobActivityRecorder(workspaceRoot, jobId, { heartbeat: true });

  const onText = (delta) => {
    activity.onText();
    try {
      fs.appendFileSync(logPath, delta, { encoding: "utf8", mode: 0o600 });
    } catch {
      // best-effort log capture
    }
  };

  let result;
  try {
    const extraArgs = request.extraArgs === undefined ? [] : request.extraArgs;
    const flag = unsupportedStoredFlag(extraArgs);
    if (flag !== null) {
      throw new Error(`stored request carries an unsupported agy flag: ${flag}`);
    }
    result = await runAgyPrint({
      prompt,
      mode: request.mode ?? "print",
      conversationId: request.conversationId,
      addDirs: request.addDirs ?? [],
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
    return 1;
  } finally {
    await activity.finish();
  }

  // One stored-result projection for both paths (076-T6 R1): the same
  // status mapping, summary derivation, and trimming helper `runForegroundJob`
  // uses, so a background run stores `agyConversationId` and the same
  // timeout retry hint the foreground path already had.
  applyDenialHint(result, stored.kind);
  const derived = deriveJobStatus(result, stored.kind);

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
    errorMessage: result.errorMessage ?? (result.status === "failed" ? trim(result.stderr) : null),
    result: buildStoredResult(result),
  });
  appendJobLog(workspaceRoot, jobId, `[worker] ${derived.status} exit=${result.exitCode} status=${result.status}`);
  return derived.status === "completed" ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`worker: fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
