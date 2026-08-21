/**
 * /antigravity:cancel — terminate an active background job.
 *
 * Sends SIGTERM to the worker pid, marks the job cancelled in state.
 */

import { readCommandInput } from "../lib/args.mjs";
import { resolveCancelableJob } from "../lib/job-control.mjs";
import { appendJobLog } from "../lib/state.mjs";
import { outputCommandResult, renderCancelReport } from "../lib/render.mjs";
import { patchJob } from "../lib/job-helpers.mjs";
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
    process.stderr.write(`antigravity:cancel — ${err?.message ?? err}\n`);
    return 1;
  }

  const pid = Number(job.pid);
  let killed = false;
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
      killed = true;
    } catch (err) {
      appendJobLog(workspaceRoot, job.id, `[cancel] kill failed: ${err?.message ?? err}`);
    }
  }
  appendJobLog(workspaceRoot, job.id, `[cancel] SIGTERM pid=${pid} killed=${killed}`);

  const completedAt = new Date().toISOString();
  const updated = await patchJob(workspaceRoot, job.id, {
    status: "cancelled",
    phase: "cancelled",
    completedAt,
    healthStatus: null,
  });

  const rendered = renderCancelReport(updated);
  outputCommandResult(
    {
      jobId: job.id,
      status: "cancelled",
      pid,
      killed,
    },
    rendered,
    json,
  );
  return 0;
}

export default run;

runIfMain(import.meta.url, run);
