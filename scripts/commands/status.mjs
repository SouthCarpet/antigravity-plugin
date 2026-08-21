/**
 * /antigravity:status — list active/recent jobs or inspect one.
 *
 * Positional: <job-id> (optional). When present, render the detailed view.
 * Flags:
 *   --wait        block until the job (or all active jobs) reach terminal state.
 *   --timeout-ms <ms>  override the wait timeout (default 15m).
 *   --json        emit JSON instead of markdown.
 */

import { readCommandInput } from "../lib/args.mjs";
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
} from "../lib/job-control.mjs";
import {
  outputCommandResult,
  renderStatusSnapshot,
  renderSingleJobStatus,
} from "../lib/render.mjs";
import { isFileLockTimeoutError } from "../lib/file-lock.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["timeout-ms", "cwd"],
    booleanOptions: ["wait", "json"],
  }, "status");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);
  const builders = {
    all: ctx.buildStatusSnapshot ?? buildStatusSnapshot,
    single: ctx.buildSingleJobSnapshot ?? buildSingleJobSnapshot,
  };

  try {
    if (reference) {
      const snapshot = builders.single(cwd, reference);
      if (options.wait) {
        const finished = await waitForSingleJob(cwd, reference, options, builders.single);
        const rendered = renderSingleJobStatus(finished);
        maybeAnnotateOAuth(finished.job);
        outputCommandResult(finished, rendered, json);
        return 0;
      }
      const rendered = renderSingleJobStatus(snapshot);
      maybeAnnotateOAuth(snapshot.job);
      outputCommandResult(snapshot, rendered, json);
      return 0;
    }

    if (options.wait) {
      const final = await waitForAllActive(cwd, options, builders.all);
      const rendered = renderStatusSnapshot(final);
      outputCommandResult(final, rendered, json);
      return 0;
    }

    const snapshot = builders.all(cwd, { env: process.env });
    const rendered = renderStatusSnapshot(snapshot);
    outputCommandResult(snapshot, rendered, json);
    return 0;
  } catch (err) {
    process.stderr.write(`antigravity:status — ${friendlyStateError(err)}\n`);
    return 1;
  }
}

async function waitForSingleJob(cwd, reference, options, buildSingle) {
  const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = buildSingle(cwd, reference);
    const status = snap.job?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return snap;
    }
    await sleep(POLL_MS);
  }
  return buildSingle(cwd, reference);
}

async function waitForAllActive(cwd, options, buildAll) {
  const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = buildAll(cwd, { env: process.env });
    if (snap.running.length === 0) return snap;
    await sleep(POLL_MS);
  }
  return buildAll(cwd, { env: process.env });
}

function friendlyStateError(error) {
  return isFileLockTimeoutError(error)
    ? "job state is busy with another update; try again shortly"
    : error?.message ?? String(error);
}

function maybeAnnotateOAuth(job) {
  if (job?.oauthUrl) {
    process.stderr.write(
      `\nantigravity:status — OAuth required. Open: ${job.oauthUrl}\n` +
        `Then run /antigravity:setup to complete the flow.\n`,
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default run;

runIfMain(import.meta.url, run);
