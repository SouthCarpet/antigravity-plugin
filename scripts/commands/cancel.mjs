/**
 * /antigravity:cancel — terminate an active background job.
 *
 * Terminates the persisted worker tree plus the agy child as a verified
 * fallback. Failed termination remains an active, retryable job state.
 */

import { readCommandInput } from "../lib/args.mjs";
import { resolveCancelableJob } from "../lib/job-control.mjs";
import { appendJobLog, recoverStateLock } from "../lib/state.mjs";
import { outputCommandResult, renderCancelReport } from "../lib/render.mjs";
import { patchJob } from "../lib/job-helpers.mjs";
import { isFileLockTimeoutError } from "../lib/file-lock.mjs";
import { terminateProcessTree } from "../lib/process.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  }, "cancel");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  let job;
  let workspaceRoot;
  try {
    ({ workspaceRoot, job } = resolveCancelableJob(cwd, reference));
  } catch (err) {
    const message = isFileLockTimeoutError(err)
      ? "job state is busy with another update; try again shortly"
      : err?.message ?? err;
    process.stderr.write(`antigravity:cancel — ${message}\n`);
    return 1;
  }

  const terminate = ctx.terminateProcessTree ?? terminateProcessTree;
  const persist = ctx.patchJob ?? patchJob;
  const output = ctx.outputCommandResult ?? outputCommandResult;
  const targets = [
    ["worker", Number(job.workerPid ?? job.pid)],
    ["agy", Number(job.agyPid)],
  ].filter(([, pid]) => Number.isInteger(pid) && pid > 0);
  const seen = new Set();
  const termination = [];
  for (const [role, pid] of targets) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const result = await terminate(pid);
    termination.push({ role, ...result });
    appendJobLog(
      workspaceRoot,
      job.id,
      `[cancel] ${role} pid=${pid} outcome=${result.outcome} status=${result.status ?? "none"}`,
    );
  }

  // A successful termination can kill the worker inside its state critical
  // section, so its finally block never removes the lock. The termination
  // result is our proof that these exact owner PIDs are gone; recover only a
  // matching lock before persisting the cancellation outcome.
  try {
    recoverStateLock(
      workspaceRoot,
      termination
        .filter((result) => result.outcome === "killed" || result.outcome === "not_found")
        .map((result) => result.pid),
    );
  } catch (err) {
    const stopped = termination.length > 0 && termination.every((result) =>
      result.outcome === "killed" || result.outcome === "not_found");
    return reportStateContention(
      job.id,
      json,
      err,
      "Process termination finished, but the state lock could not be recovered.",
      output,
      stopped,
    );
  }

  const failures = termination.filter((result) =>
    result.outcome !== "killed" && result.outcome !== "not_found");
  if (termination.length === 0 || failures.length > 0) {
    const message = termination.length === 0
      ? "Cancellation failed because the job has no recorded worker or agy process id."
      : `Cancellation failed: ${failures.map((result) =>
          `${result.role} pid ${result.pid}: ${result.message}`).join("; ")}`;
    appendJobLog(workspaceRoot, job.id, `[cancel] ${message}`);
    let updated;
    try {
      updated = await persist(workspaceRoot, job.id, {
        phase: "cancel_failed",
        healthStatus: "cancel_failed",
        healthMessage: message,
        recommendedAction: "Retry cancellation or terminate the reported PID manually.",
        errorMessage: message,
      });
    } catch (err) {
      return reportStateContention(job.id, json, err, message, output);
    }
    output(
      { jobId: job.id, status: "cancel_failed", killed: false, termination, message },
      ["# Antigravity Cancel", "", `Could not cancel ${job.id}.`, "", message,
        `- Status: ${updated.status}`, `- Phase: ${updated.phase}`].join("\n") + "\n",
      json,
    );
    return 1;
  }

  const completedAt = new Date().toISOString();
  let updated;
  try {
    updated = await persist(workspaceRoot, job.id, {
      status: "cancelled",
      phase: "cancelled",
      completedAt,
      healthStatus: null,
    });
  } catch (err) {
    return reportStateContention(
      job.id,
      json,
      err,
      "The process tree stopped, but its cancelled state could not be saved.",
      output,
      true,
    );
  }

  const rendered = renderCancelReport(updated);
  output(
    {
      jobId: job.id,
      status: "cancelled",
      pid: Number(job.workerPid ?? job.pid),
      workerPid: Number(job.workerPid ?? job.pid) || null,
      agyPid: Number(job.agyPid) || null,
      killed: termination.some((result) => result.outcome === "killed"),
      stopped: true,
      termination,
    },
    rendered,
    json,
  );
  return 0;
}

function reportStateContention(jobId, json, error, prefix, output, stopped = false) {
  const detail = isFileLockTimeoutError(error)
    ? "Job state is busy with another update. Check status and retry shortly."
    : `Could not update job state: ${error?.message ?? error}`;
  const message = `${prefix} ${detail}`;
  output(
    { jobId, status: "state_busy", killed: stopped, stopped, message },
    `# Antigravity Cancel\n\n${message}\n`,
    json,
  );
  return 1;
}

export default run;

runIfMain(import.meta.url, run);
