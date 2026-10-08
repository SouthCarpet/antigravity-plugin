/**
 * /antigravity:status — list active/recent jobs or inspect one.
 *
 * Positional: <job-id> (optional). When present, render the detailed view.
 * Flags:
 *   --wait        block until the job (or all active jobs) reach terminal state.
 *   --timeout-ms <ms>  override the wait timeout (default 15m).
 *   --exit-status opt-in: exit by the waited job's own outcome instead of
 *                 the usual 0 (requires a job id and --wait).
 *   --json        emit JSON instead of markdown.
 */

import { readCommandInput } from "../lib/args.mjs";
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
} from "../lib/job-control.mjs";
import {
  createErrorEnvelope,
  createJsonEnvelope,
  outputCommandResult,
  renderStatusSnapshot,
  renderSingleJobStatus,
} from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";
import { readUpdateNotice } from "../lib/update.mjs";
import {
  classifyStateError,
  deniedActionsWithRemedy,
  exitCodeForJobStatus,
  reportArgsValidationError,
  waitOutcomeLine,
} from "../lib/job-helpers.mjs";
import { getConfig } from "../lib/state.mjs";
import { classifyAgyVersion, LAST_MEASURED_AGY_VERSION } from "../lib/compat.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";

const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

/**
 * @param {string[]} [argv] CLI arguments after the verb (an optional job reference and flags)
 * @param {{ cwd?: string, buildStatusSnapshot?: typeof buildStatusSnapshot,
 *   buildSingleJobSnapshot?: typeof buildSingleJobSnapshot,
 *   readUpdateNotice?: typeof readUpdateNotice }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["timeout-ms", "cwd"],
    booleanOptions: ["wait", "json", "exit-status"],
  }, "status");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);
  const exitStatus = Boolean(options["exit-status"]);
  if (exitStatus && (!reference || !options.wait)) {
    return reportArgsValidationError("status", "--exit-status requires a job id and --wait");
  }
  const builders = {
    all: ctx.buildStatusSnapshot ?? buildStatusSnapshot,
    single: ctx.buildSingleJobSnapshot ?? buildSingleJobSnapshot,
  };

  try {
    if (reference) {
      const snapshot = withDenialRemedies(builders.single(cwd, reference));
      if (options.wait) {
        const finished = withDenialRemedies(await waitForSingleJob(cwd, reference, options, builders.single));
        const rendered = renderSingleJobStatus(finished);
        outputCommandResult(statusEnvelope(finished), rendered, json);
        return exitStatus ? exitStatusOutcome(finished.job) : 0;
      }
      const rendered = renderSingleJobStatus(snapshot);
      outputCommandResult(statusEnvelope(snapshot), rendered, json);
      return 0;
    }

    if (options.wait) {
      const final = await waitForAllActive(cwd, options, builders.all);
      const rendered = renderStatusSnapshot(final);
      outputCommandResult(statusEnvelope(final), rendered, json);
      printAgyVersionWarning(cwd, ctx);
      printUpdateNotice(ctx);
      return 0;
    }

    const snapshot = builders.all(cwd, { env: process.env });
    const rendered = renderStatusSnapshot(snapshot);
    outputCommandResult(statusEnvelope(snapshot), rendered, json);
    printAgyVersionWarning(cwd, ctx);
    printUpdateNotice(ctx);
    return 0;
  } catch (err) {
    return reportStatusStateError(err, json);
  }
}

/**
 * Report a job-lookup/state-read failure from the `try` block above: the
 * existing stderr line, unchanged, plus (Task 3, "Senate R1", 2026-09) one
 * `state_error` `--json` envelope when `json` is true. `jobId` is always
 * `null` here — every throw site this catches fails before it resolves a
 * job.
 *
 * @param {unknown} err
 * @param {boolean} json
 * @returns {1}
 */
function reportStatusStateError(err, json) {
  const { code, message } = classifyStateError(err);
  process.stderr.write(`antigravity:status — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope("status", { status: "state_error", error: { code, phase: "state", message } }),
    "",
    json,
  );
  return 1;
}

/**
 * Attach denial remedies to a single-job snapshot's `job.deniedActions`
 * (plan 085 T2 item 4): the raw `{ action, displayName, source }` list
 * job-control.mjs carries through becomes `{ action, displayName, remedy }`
 * here, using the job's own `kind` — computed fresh (not persisted) so a
 * remedy wording change never rewrites a stored record. A no-op when the
 * job has no denials, or when `snapshot.job` is missing (a `--wait` timeout
 * on a vanished record).
 *
 * @param {{ job?: import('../lib/types.mjs').JobRecord } | null | undefined} snapshot
 * @returns {{ job?: import('../lib/types.mjs').JobRecord } | null | undefined}
 */
function withDenialRemedies(snapshot) {
  const list = deniedActionsWithRemedy(snapshot?.job?.deniedActions, snapshot?.job?.kind);
  if (!list) return snapshot;
  return { ...snapshot, job: { ...snapshot.job, deniedActions: list } };
}

/**
 * Map `--exit-status`'s post-wait outcome onto the process exit code (Task
 * 8, "Senate R10", 2026-09): a terminal job's status feeds the same
 * {@link exitCodeForJobStatus} every other verb uses (0 completed, 1
 * failed, 2 cancelled); a job still `queued`/`running` once the wait
 * deadline passed prints one stderr line and exits 3. The snapshot's own
 * output (already written by the caller) is unaffected either way.
 *
 * A vanished job record (`job` is `undefined`: the index entry disappeared
 * while `--wait` was polling it) has no status to report either, so it
 * takes the same "wait timed out" exit code (3) as a job still
 * `queued`/`running` when the deadline passed, with the one shared line
 * {@link waitOutcomeLine} already prints for this exact case elsewhere
 * (`buildShowResultEnvelope`'s `--show-result` counterpart).
 *
 * @param {import('../lib/types.mjs').JobRecord | undefined} job
 * @returns {number}
 */
function exitStatusOutcome(job) {
  if (!job) {
    process.stderr.write(`${waitOutcomeLine("status", job)}\n`);
    return 3;
  }
  const status = job.status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return exitCodeForJobStatus(status);
  }
  process.stderr.write(`antigravity:status — wait timed out; job ${job.id} is still ${status}.\n`);
  return 3;
}

function statusEnvelope(snapshot) {
  return createJsonEnvelope("status", {
    status: snapshot.job?.status ?? "ok",
    jobId: snapshot.job?.id ?? null,
    details: snapshot,
  });
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

/**
 * One line on stderr when the update cache already knows a newer version.
 * Cache only: `status` never calls the network (docs/COMPATIBILITY.md).
 */
function printUpdateNotice(ctx) {
  const notice = (ctx.readUpdateNotice ?? readUpdateNotice)();
  if (notice) process.stderr.write(`${notice}\n`);
}

/** Classifications that earn `printAgyVersionWarning`'s one stderr line. */
const AGY_VERSION_WARNING_CLASSIFICATIONS = new Set(["beyond_measured", "unmeasured"]);

/**
 * One stderr line when the cached `agyVersionSeen` (written by `review`,
 * `rescue`, `task`, or `vision` after their own probe, see
 * `job-helpers.mjs#rememberAgyVersion`) falls outside this plugin's measured
 * range. Reads only the state config; never calls agy itself (Senate R2,
 * 2026-09). A no-reference `status` call only, never printed for
 * `status <id>`.
 *
 * @param {string} cwd
 * @param {{ getConfig?: typeof getConfig, resolveWorkspaceRoot?: typeof resolveWorkspaceRoot }} ctx
 * @returns {void}
 */
function printAgyVersionWarning(cwd, ctx) {
  const resolve = ctx.resolveWorkspaceRoot ?? resolveWorkspaceRoot;
  const readConfig = ctx.getConfig ?? getConfig;
  const seen = readConfig(resolve(cwd))?.agyVersionSeen;
  if (!seen?.version || !AGY_VERSION_WARNING_CLASSIFICATIONS.has(classifyAgyVersion(seen.version))) return;
  const date = typeof seen.observedAt === "string" ? seen.observedAt.slice(0, 10) : "unknown date";
  process.stderr.write(
    `antigravity:status — agy ${seen.version} (seen ${date}) is newer than the last measured version ${LAST_MEASURED_AGY_VERSION}.\n`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default run;

runIfMain(import.meta.url, run);
