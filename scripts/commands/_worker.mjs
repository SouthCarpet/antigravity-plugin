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
import { applyDenialHint, headlessDenialHint, patchJob } from "../lib/job-helpers.mjs";

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

  const onText = (delta) => {
    try {
      fs.appendFileSync(logPath, delta, { encoding: "utf8", mode: 0o600 });
    } catch {
      // best-effort log capture
    }
  };

  let result;
  try {
    result = await runAgyPrint({
      prompt,
      mode: request.mode ?? "print",
      conversationId: request.conversationId,
      addDirs: request.addDirs ?? [],
      extraArgs: request.extraArgs ?? [],
      cwd: request.cwd ?? workspaceRoot,
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
  } catch (err) {
    appendJobLog(workspaceRoot, jobId, `[worker] error: ${err?.message ?? err}`);
    await patchJob(workspaceRoot, jobId, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: err?.message ?? String(err),
      healthStatus: "failed",
    });
    process.exit(1);
  }

  const status =
    result.status === "completed"
      ? "completed"
      : result.status === "cancelled"
      ? "cancelled"
      : "failed";
  const oauth = result.oauthUrl ?? null;
  applyDenialHint(result, stored.kind);
  const summary = deriveSummary(result.stdout);

  await patchJob(workspaceRoot, jobId, {
    status,
    phase: status,
    completedAt: new Date().toISOString(),
    exitCode: result.exitCode,
    summary,
    oauthUrl: oauth,
    healthStatus:
      result.status === "auth_required" ? "auth_required" : status === "failed" ? "failed" : null,
    healthMessage:
      result.status === "auth_required"
        ? "Antigravity is not authenticated. Complete OAuth and retry."
        : result.denial && status === "failed"
        ? `agy auto-denied the "${result.denial.tool}" tool (headless mode cannot prompt) and produced no output.`
        : null,
    recommendedAction:
      result.status === "auth_required"
        ? "Run /antigravity:setup to complete the OAuth flow."
        : result.denial && status === "failed"
        ? headlessDenialHint(stored.kind)
        : null,
    errorMessage: status === "failed" ? trim(result.stderr) : null,
    result: {
      rawOutput: result.stdout,
      stderr: result.stderr,
      status: result.status,
      exitCode: result.exitCode,
      oauthUrl: oauth,
      usage: result.usage ?? null,
      durationSeconds: result.durationSeconds ?? null,
      agyConversationId: result.agyConversationId ?? null,
      warnings: result.warnings ?? [],
    },
  });
  appendJobLog(workspaceRoot, jobId, `[worker] ${status} exit=${result.exitCode}`);
  process.exit(status === "completed" ? 0 : 1);
}

function deriveSummary(stdout) {
  if (typeof stdout !== "string") return null;
  const firstLine = stdout.split("\n").map((s) => s.trim()).find(Boolean);
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function trim(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

main().catch((err) => {
  process.stderr.write(`worker: fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
