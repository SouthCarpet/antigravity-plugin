/**
 * /antigravity:result — fetch a finished job's stored output.
 *
 * Exit codes:
 *   0  completed
 *   1  failed (or no job found)
 *   2  cancelled
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { mergeJobDetail, resolveResultJob } from "../lib/job-control.mjs";
import { readJobFile, validateJobRecord } from "../lib/state.mjs";
import { createJsonEnvelope, outputCommandResult, renderResultOutput } from "../lib/render.mjs";
import { isFileLockTimeoutError } from "../lib/file-lock.mjs";
import { exitCodeForJobStatus } from "../lib/job-helpers.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

/**
 * Run a job-state read (`resolveResultJob`/`readJobFile`) and turn a lock
 * timeout, or any other failure, into the one message this verb prints.
 *
 * @template T
 * @param {() => T} fn
 * @returns {{ ok: true, value: T } | { ok: false, message: string }}
 */
function readJobState(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    const message = isFileLockTimeoutError(err)
      ? "job state is busy with another update; try again shortly"
      : err?.message ?? err;
    return { ok: false, message };
  }
}

/**
 * Print agy's measured token usage to stderr when the stored result carries
 * it. The ledger rule requires recording measured totals — this trailer is
 * what the orchestrator reads.
 *
 * @param {import('../lib/types.mjs').JobRecord | null} stored
 * @returns {void}
 */
function printMeasuredUsageTrailer(stored) {
  const usage = stored?.result?.usage ?? null;
  if (!usage || typeof usage.total_tokens !== "number") return;
  process.stderr.write(
    `usage: total=${usage.total_tokens} in=${usage.input_tokens ?? "?"} ` +
      `out=${usage.output_tokens ?? "?"}\n`,
  );
}

/**
 * @param {import('../lib/types.mjs').JobIndexEntry} job
 * @param {import('../lib/types.mjs').JobRecord | null} stored
 * @returns {{ conversationId: string | null, result: object | null }}
 */
function buildResultDetails(job, stored) {
  return {
    conversationId: stored?.conversationId ?? job.conversationId ?? null,
    result: stored?.result ?? null,
  };
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a job reference and flags)
 * @param {{ cwd?: string, resolveResultJob?: typeof resolveResultJob,
 *   readJobFile?: typeof readJobFile }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code (0 completed, 1 failed/not found, 2 cancelled)
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  }, "result");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = resolveCliCwd(options, ctx);
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  const resolved = readJobState(() => (ctx.resolveResultJob ?? resolveResultJob)(cwd, reference));
  if (!resolved.ok) {
    process.stderr.write(`antigravity:result — ${resolved.message}\n`);
    return 1;
  }
  const { workspaceRoot } = resolved.value;
  let job = resolved.value.job;

  const storedRead = readJobState(() => (ctx.readJobFile ?? readJobFile)(workspaceRoot, job.id));
  if (!storedRead.ok) {
    process.stderr.write(`antigravity:result — ${storedRead.message}\n`);
    return 1;
  }
  const stored = storedRead.value;

  if (!validateJobRecord(stored) || stored.id !== job.id) {
    process.stderr.write(`antigravity:result — stored job ${job.id} is unreadable.\n`);
    return 1;
  }
  job = mergeJobDetail(job, stored);

  printMeasuredUsageTrailer(stored);

  const rendered = renderResultOutput(workspaceRoot, job, stored);
  const payload = createJsonEnvelope("result", {
    status: job.status,
    jobId: job.id,
    answer: rendered,
    details: buildResultDetails(job, stored),
  });
  outputCommandResult(payload, rendered, json);

  return exitCodeForJobStatus(job.status);
}

export default run;

runIfMain(import.meta.url, run);
