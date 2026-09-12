/**
 * /antigravity:result — fetch a finished job's stored output.
 *
 * Flags:
 *   --head <n>   show only the first n lines of the answer (positive integer)
 *   --tail <n>   show only the last n lines of the answer (positive integer;
 *                may be combined with --head)
 *   --json       emit JSON
 *
 * Exit codes:
 *   0  completed
 *   1  failed (or no job found)
 *   2  cancelled
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { mergeJobDetail, resolveResultJob } from "../lib/job-control.mjs";
import { readJobFile, validateJobRecord } from "../lib/state.mjs";
import { createJsonEnvelope, outputCommandResult, renderResultOutput, renderDeniedActionLines, renderPrintTimeoutNote } from "../lib/render.mjs";
import { isFileLockTimeoutError } from "../lib/file-lock.mjs";
import { exitCodeForJobStatus, deniedActionsWithRemedy } from "../lib/job-helpers.mjs";
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
 * @param {{ truncated: boolean, text?: string }} [cut] the same cut
 *   `buildResultOutput` applied to `answer` (076-T7 fix round 1, F9): when
 *   truncated, `details.result.rawOutput` gets the same cut text instead of
 *   the full stored answer, so the `--json` path saves the same bytes the
 *   markdown path does.
 * @returns {{ conversationId: string | null, agyConversationId: string | null, result: object | null }}
 */
function buildResultDetails(job, stored, cut) {
  const result = stored?.result ?? null;
  const rawOutput =
    cut?.truncated && typeof result?.rawOutput === "string" ? cut.text : result?.rawOutput;
  return {
    conversationId: stored?.conversationId ?? job.conversationId ?? null,
    // The id agy itself reported, distinct from `conversationId` above (the
    // id the caller passed in) — already nested at `result.agyConversationId`
    // via `buildStoredResult`; also surfaced at this top level (plan 086 T5k
    // F1 item 2) so a host reading `result <id> --json` finds it in the same
    // place `status <id> --json`'s `details.job.agyConversationId` puts it.
    agyConversationId: stored?.result?.agyConversationId ?? null,
    result: result ? { ...result, rawOutput } : result,
  };
}

/**
 * Parse a `--head`/`--tail` value: a positive integer, or `undefined` when
 * the flag was not given. Anything else is the same `ArgsError` shape every
 * other flag uses (076-T7 R1).
 *
 * @param {string | boolean | undefined} value
 * @param {string} flag
 * @returns {{ ok: true, value: number | undefined } | { ok: false, error: string }}
 */
function parsePositiveIntFlag(value, flag) {
  if (value === undefined) return { ok: true, value: undefined };
  if (!/^[0-9]+$/.test(String(value)) || Number(value) <= 0) {
    return { ok: false, error: `invalid value for --${flag}: "${value}" (expected a positive integer)` };
  }
  return { ok: true, value: Number(value) };
}

/**
 * Cut `text` to at most `head` lines from the start plus `tail` lines from
 * the end (both may be given; the two windows never overlap). Lines only —
 * never a byte offset — so a multi-byte UTF-8 character is never split.
 * Without either option, or when nothing is actually cut, `truncated` is
 * `false` and `text` is returned unchanged (076-T7 R1).
 *
 * @param {string} text
 * @param {{ head?: number, tail?: number }} options
 * @returns {{ text: string, truncated: boolean, shown: number, total: number }}
 */
export function cutAnswerLines(text, { head, tail } = {}) {
  const lines = text.split("\n");
  const total = lines.length;
  if (!head && !tail) return { text, truncated: false, shown: total, total };
  const headLines = head ? lines.slice(0, head) : [];
  const tailStart = tail ? Math.max(lines.length - tail, head ?? 0) : lines.length;
  const tailLines = tail ? lines.slice(tailStart) : [];
  const kept = [...headLines, ...tailLines];
  if (kept.length >= total) return { text, truncated: false, shown: total, total };
  return { text: kept.join("\n"), truncated: true, shown: kept.length, total };
}

/**
 * Resolve and validate the job this invocation addresses: the index entry,
 * its stored detail record, merged. Every failure path prints the one
 * `antigravity:result — <reason>` line and this returns `null` for the
 * caller to `return 1` on.
 *
 * @param {string} cwd
 * @param {string | null} reference
 * @param {{ resolveResultJob?: typeof resolveResultJob, readJobFile?: typeof readJobFile }} ctx
 * @returns {{ workspaceRoot: string, job: import('../lib/types.mjs').JobRecord,
 *   stored: import('../lib/types.mjs').JobRecord } | null}
 */
function resolveJobAndStored(cwd, reference, ctx) {
  const resolved = readJobState(() => (ctx.resolveResultJob ?? resolveResultJob)(cwd, reference));
  if (!resolved.ok) {
    process.stderr.write(`antigravity:result — ${resolved.message}\n`);
    return null;
  }
  const { workspaceRoot } = resolved.value;
  const indexJob = resolved.value.job;

  const storedRead = readJobState(() => (ctx.readJobFile ?? readJobFile)(workspaceRoot, indexJob.id));
  if (!storedRead.ok) {
    process.stderr.write(`antigravity:result — ${storedRead.message}\n`);
    return null;
  }
  const stored = storedRead.value;

  if (!validateJobRecord(stored) || stored.id !== indexJob.id) {
    process.stderr.write(`antigravity:result — stored job ${indexJob.id} is unreadable.\n`);
    return null;
  }
  return { workspaceRoot, job: mergeJobDetail(indexJob, stored), stored };
}

/**
 * Build the markdown and `--json` output for a resolved job, applying the
 * `--head`/`--tail` cut when requested (076-T7 R1).
 *
 * @param {{ workspaceRoot: string, job: import('../lib/types.mjs').JobRecord,
 *   stored: import('../lib/types.mjs').JobRecord }} resolved
 * @param {{ head?: number, tail?: number }} lineWindow
 * @returns {{ rendered: string, payload: object }}
 */
function buildResultOutput({ workspaceRoot, job, stored }, { head, tail }) {
  const rendered = renderResultOutput(workspaceRoot, job, stored);

  // The cut applies to the stored answer text itself (rawOutput), the same
  // text `buildStoredResult` projected — not to `rendered`'s appended
  // trailing newline or its metadata-fallback shape.
  const rawAnswer = typeof stored?.result?.rawOutput === "string" ? stored.result.rawOutput : null;
  const cut = rawAnswer !== null && (head || tail)
    ? cutAnswerLines(rawAnswer, { head, tail })
    : { truncated: false };
  const renderedOut = cut.truncated
    ? `${cut.text}${cut.text.endsWith("\n") ? "" : "\n"}(showing ${cut.shown} of ${cut.total} lines; full answer stored)\n`
    : rendered;
  // Plan 085 T2 item 4: when the stored result carries denials, one markdown
  // line per action with its remedy is appended after the answer text (never
  // folded into the opaque `answer`/`rendered` text above), plus the same
  // `{ action, displayName, remedy }` list under `details.deniedActions`.
  const deniedList = deniedActionsWithRemedy(stored?.result?.deniedActions, job.kind);
  const withDenied = deniedList
    ? `${renderedOut}${renderDeniedActionLines(deniedList).join("\n")}\n`
    : renderedOut;
  // Plan 086 T1 item 4: when the stored result carries agy's own
  // print-timeout marker, one note line is appended after the denied-action
  // section (never folded into the opaque `answer`/`rendered` text above),
  // plus `details.agyPrintTimeout` on `--json` — distinct from
  // `details.truncated` above, which already means the `--head`/`--tail`
  // display cut.
  const agyPrintTimeout = stored?.result?.agyPrintTimeout ?? null;
  const printTimeoutNote = renderPrintTimeoutNote(agyPrintTimeout);
  const finalRendered = printTimeoutNote.length
    ? `${withDenied}${printTimeoutNote.join("\n")}\n`
    : withDenied;
  const payload = createJsonEnvelope("result", {
    status: job.status,
    jobId: job.id,
    answer: cut.truncated ? cut.text : rendered,
    details: {
      ...buildResultDetails(job, stored, cut),
      ...(cut.truncated ? { truncated: true } : {}),
      ...(deniedList ? { deniedActions: deniedList } : {}),
      ...(agyPrintTimeout ? { agyPrintTimeout } : {}),
    },
  });
  return { rendered: finalRendered, payload };
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a job reference and flags)
 * @param {{ cwd?: string, resolveResultJob?: typeof resolveResultJob,
 *   readJobFile?: typeof readJobFile }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code (0 completed, 1 failed/not found, 2 cancelled)
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["cwd", "head", "tail"],
    booleanOptions: ["json"],
  }, "result");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const head = parsePositiveIntFlag(options.head, "head");
  if (!head.ok) {
    process.stderr.write(`antigravity:result — ${head.error}\n`);
    return 1;
  }
  const tail = parsePositiveIntFlag(options.tail, "tail");
  if (!tail.ok) {
    process.stderr.write(`antigravity:result — ${tail.error}\n`);
    return 1;
  }

  const cwd = resolveCliCwd(options, ctx);
  const reference = positionals[0] ?? null;
  const json = Boolean(options.json);

  const resolved = resolveJobAndStored(cwd, reference, ctx);
  if (!resolved) return 1;

  printMeasuredUsageTrailer(resolved.stored);
  const { rendered, payload } = buildResultOutput(resolved, { head: head.value, tail: tail.value });
  outputCommandResult(payload, rendered, json);

  return exitCodeForJobStatus(resolved.job.status);
}

export default run;

runIfMain(import.meta.url, run);
