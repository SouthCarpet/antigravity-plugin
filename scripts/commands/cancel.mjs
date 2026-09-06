/**
 * /antigravity:cancel — terminate an active background job.
 *
 * Terminates the persisted worker tree plus the agy child as a verified
 * fallback. Failed termination remains an active, retryable job state.
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveCancelableJob } from "../lib/job-control.mjs";
import { appendJobLog, recoverStateLock } from "../lib/state.mjs";
import { createJsonEnvelope, outputCommandResult, renderCancelReport } from "../lib/render.mjs";
import { patchJob } from "../lib/job-helpers.mjs";
import { isFileLockTimeoutError } from "../lib/file-lock.mjs";
import { terminateProcessTree } from "../lib/process.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

/**
 * The worker/agy PIDs a cancel actually needs to terminate: numeric,
 * positive, and named by role.
 *
 * @param {import('../lib/types.mjs').JobIndexEntry} job
 * @returns {[string, number][]}
 */
function resolveCancelTargets(job) {
  return [
    ["worker", Number(job.workerPid ?? job.pid)],
    ["agy", Number(job.agyPid)],
  ].filter(([, pid]) => Number.isInteger(pid) && pid > 0);
}

/**
 * @param {{ outcome: string }} result
 * @returns {boolean} true for a target that is confirmed gone
 */
function isStoppedOutcome(result) {
  return result.outcome === "killed" || result.outcome === "not_found";
}

/**
 * Terminate every cancel target once (deduped by pid), logging each outcome.
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {[string, number][]} targets
 * @param {typeof terminateProcessTree} terminate
 * @returns {Promise<object[]>}
 */
async function terminateCancelTargets(workspaceRoot, jobId, targets, terminate) {
  const seen = new Set();
  const termination = [];
  for (const [role, pid] of targets) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const result = await terminate(pid);
    termination.push({ role, ...result });
    appendJobLog(
      workspaceRoot,
      jobId,
      `[cancel] ${role} pid=${pid} outcome=${result.outcome} status=${result.status ?? "none"}`,
    );
  }
  return termination;
}

/**
 * A successful termination can kill the worker inside its state critical
 * section, so its finally block never removes the lock. The termination
 * result is our proof that these exact owner PIDs are gone; recover only a
 * matching lock before persisting the cancellation outcome.
 *
 * @returns {number | null} an exit code on failure, else null to continue
 */
function recoverAfterTermination(workspaceRoot, job, termination, json, output) {
  try {
    recoverStateLock(workspaceRoot, termination.filter(isStoppedOutcome).map((result) => result.pid));
    return null;
  } catch (err) {
    const stopped = termination.length > 0 && termination.every(isStoppedOutcome);
    return reportStateContention(
      job.id,
      json,
      err,
      "Process termination finished, but the state lock could not be recovered.",
      output,
      stopped,
    );
  }
}

/**
 * Persist and report a cancellation where some target never stopped.
 *
 * @returns {Promise<number>} exit code
 */
async function reportCancelFailure(workspaceRoot, job, termination, persist, output, json) {
  const failures = termination.filter((result) => !isStoppedOutcome(result));
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
    createJsonEnvelope("cancel", {
      jobId: job.id,
      status: "cancel_failed",
      details: { killed: false, termination, message },
    }),
    ["# Antigravity Cancel", "", `Could not cancel ${job.id}.`, "", message,
      `- Status: ${updated.status}`, `- Phase: ${updated.phase}`].join("\n") + "\n",
    json,
  );
  return 1;
}

/**
 * Persist and report a cancellation where every target stopped.
 *
 * @returns {Promise<number>} exit code
 */
async function reportCancelSuccess(workspaceRoot, job, termination, persist, output, json) {
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
    createJsonEnvelope("cancel", {
      jobId: job.id,
      status: "cancelled",
      details: {
        pid: Number(job.workerPid ?? job.pid),
        workerPid: Number(job.workerPid ?? job.pid) || null,
        agyPid: Number(job.agyPid) || null,
        killed: termination.some((result) => result.outcome === "killed"),
        stopped: true,
        termination,
      },
    }),
    rendered,
    json,
  );
  return 0;
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a job reference and flags)
 * @param {{ cwd?: string, terminateProcessTree?: typeof terminateProcessTree,
 *   patchJob?: typeof patchJob, outputCommandResult?: typeof outputCommandResult }} [ctx]
 *   dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  }, "cancel");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = resolveCliCwd(options, ctx);
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

  const termination = await terminateCancelTargets(workspaceRoot, job.id, resolveCancelTargets(job), terminate);

  const lockFailureExitCode = recoverAfterTermination(workspaceRoot, job, termination, json, output);
  if (lockFailureExitCode !== null) return lockFailureExitCode;

  const allStopped = termination.length > 0 && termination.every(isStoppedOutcome);
  if (!allStopped) {
    return reportCancelFailure(workspaceRoot, job, termination, persist, output, json);
  }

  return reportCancelSuccess(workspaceRoot, job, termination, persist, output, json);
}

function reportStateContention(jobId, json, error, prefix, output, stopped = false) {
  const detail = isFileLockTimeoutError(error)
    ? "Job state is busy with another update. Check status and retry shortly."
    : `Could not update job state: ${error?.message ?? error}`;
  const message = `${prefix} ${detail}`;
  output(
    createJsonEnvelope("cancel", {
      jobId,
      status: "state_busy",
      details: { killed: stopped, stopped, message },
    }),
    `# Antigravity Cancel\n\n${message}\n`,
    json,
  );
  return 1;
}

export default run;

runIfMain(import.meta.url, run);
