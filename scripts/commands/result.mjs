/**
 * /antigravity:result — fetch a finished job's stored output.
 *
 * Exit codes:
 *   0  completed
 *   1  failed (or no job found)
 *   2  cancelled
 */

import { readCommandInput } from "../lib/args.mjs";
import { resolveResultJob } from "../lib/job-control.mjs";
import { readJobFile } from "../lib/state.mjs";
import { createJsonEnvelope, outputCommandResult, renderResultOutput } from "../lib/render.mjs";
import { isFileLockTimeoutError } from "../lib/file-lock.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  }, "result");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  let job;
  let workspaceRoot;
  try {
    ({ workspaceRoot, job } = (ctx.resolveResultJob ?? resolveResultJob)(cwd, reference));
  } catch (err) {
    const message = isFileLockTimeoutError(err)
      ? "job state is busy with another update; try again shortly"
      : err?.message ?? err;
    process.stderr.write(`antigravity:result — ${message}\n`);
    return 1;
  }

  let stored;
  try {
    stored = (ctx.readJobFile ?? readJobFile)(workspaceRoot, job.id);
  } catch (err) {
    const message = isFileLockTimeoutError(err)
      ? "job state is busy with another update; try again shortly"
      : err?.message ?? err;
    process.stderr.write(`antigravity:result — ${message}\n`);
    return 1;
  }

  const usage = stored?.result?.usage ?? null;
  if (usage && typeof usage.total_tokens === "number") {
    // Measured by agy itself (json envelope). The ledger rule requires
    // recording measured totals — this trailer is what the orchestrator reads.
    process.stderr.write(
      `usage: total=${usage.total_tokens} in=${usage.input_tokens ?? "?"} ` +
        `out=${usage.output_tokens ?? "?"}\n`,
    );
  }

  const rendered = renderResultOutput(workspaceRoot, job, stored);
  const payload = createJsonEnvelope("result", {
    status: job.status,
    jobId: job.id,
    answer: rendered,
    details: {
      conversationId: stored?.conversationId ?? job.conversationId ?? null,
      result: stored?.result ?? null,
    },
  });
  outputCommandResult(payload, rendered, json);

  switch (job.status) {
    case "completed":
      return 0;
    case "cancelled":
      return 2;
    default:
      return 1;
  }
}

export default run;

runIfMain(import.meta.url, run);
