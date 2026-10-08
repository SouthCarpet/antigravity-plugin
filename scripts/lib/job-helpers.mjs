/**
 * job-helpers — shared helpers for command modules.
 *
 * Provides job id minting, foreground/background tracking glue, and stdout
 * persistence around `runAgyPrint`. The prompt travels to `agy` over stdin
 * as a single stream-json line, not argv (see agent-runtime.mjs); the
 * response streams back as NDJSON events, and readable text arrives
 * incrementally via `step_update.text_delta` events (surfaced here through
 * the `onText` callback) rather than as one final blob.
 */

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { runAgyPrint, resolveAgyBin, probeAgy } from "./agent-runtime.mjs";
import { safeFailureReason } from "./safe-reason.mjs";
import { spawn } from "./process-adapter.mjs";
import {
  appendJobLog,
  claimRequestId,
  resolveJobLogFile,
  patchJobState,
  patchJobStateUnlocked,
  readJobFile,
  getConfig,
  setConfig,
} from "./state.mjs";
import { requestFingerprint } from "./request-id.mjs";
import { SESSION_ID_ENV } from "./job-control.mjs";
import { isProcessAlive as processIsAlive, terminateProcessTree } from "./process.mjs";
import { createJobActivityRecorder } from "./job-activity.mjs";
import { readRunningVersion } from "./update.mjs";
import { isFileLockTimeoutError } from "./file-lock.mjs";
import {
  createJsonEnvelope,
  createErrorEnvelope,
  outputCommandResult,
  reportWarnings,
  warningDetails,
  formatDeniedActionLabel,
  stripBypassAdvice,
  redactBypassFlag,
  appendRenderedLines,
} from "./render.mjs";
import { buildResultDetails } from "./job-result.mjs";
import { findingsWarningLine, storedFindingsDetails, structuredRawText } from "./review-findings.mjs";

export const AGY_TIMEOUT_ENV = "ANTIGRAVITY_AGY_TIMEOUT_MS";
export const DEFAULT_AGY_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} the agy execution budget in ms
 */
export function agyTimeoutMs(env = process.env) {
  const value = env[AGY_TIMEOUT_ENV];
  if (value === undefined) return DEFAULT_AGY_TIMEOUT_MS;
  if (value === "0") return 0;
  const milliseconds = Number(value);
  if (/^[0-9]+$/.test(value) && Number.isSafeInteger(milliseconds) &&
      milliseconds > 0 && milliseconds <= 0x7fffffff) return milliseconds;
  process.stderr.write(`antigravity: ignoring ${AGY_TIMEOUT_ENV}=${String(value).replace(/[\r\n]/g, ' ')} (not a positive integer of milliseconds)\n`);
  return DEFAULT_AGY_TIMEOUT_MS;
}

/**
 * Generate a short, URL-safe job id (12 hex chars).
 *
 * @returns {string}
 */
export function newJobId() {
  return randomBytes(6).toString("hex");
}

/** Values agy accepts for `--mode` (agy 1.1.24 `--help`). */
export const AGY_MODES = ["plan", "accept-edits"];

/** Values agy accepts for `--effort` (agy 1.1.27 `--help`: "Reasoning effort
 * for the current CLI session (low|medium|high)"). agy 1.2.11 `--help`
 * lists a fourth choice, `max`, but no model on this account exposes it
 * (`raw-effort-max-default-model.txt`: "gemini-3.8-flash has no \"max\"
 * effort (available: low, medium, high)"), so the plugin keeps accepting
 * only these three plus the sentinel below. `vision` never exposes
 * `--effort`. `task` and `rescue` forward it with a plugin-side default
 * ({@link resolveRequestEffort}); `review` forwards it too, through
 * {@link EFFORT_CHOICES} and {@link resolveReviewEffort}, but with no
 * plugin-side default of its own.
 *
 * agy 1.3.1 `--help` lists `xhigh`, but every model refused `xhigh` and
 * `max` when probed on 2026-10-08 (plan 118 probes D1 to D6), so `xhigh`
 * stays out of this list. */
export const AGY_EFFORTS = ["low", "medium", "high"];

/**
 * The `--effort` value `task` and `rescue` apply when neither `--effort`
 * nor `--model` is given (plan 086 T2, disclosed 1.x default; the model
 * case is `resolveRequestEffort`). Measured basis: a run without `--effort`
 * sends no effort field at all, so the value agy uses comes from whatever
 * that machine has saved — a delegated run is not reproducible across
 * machines without a plugin default. `vision` does not read this constant:
 * it exposes no `--effort` at all. `review` does not read it either, but for
 * a different reason: it exposes `--effort` (via {@link resolveReviewEffort})
 * without ever falling back to a plugin default.
 */
export const DEFAULT_AGY_EFFORT = "medium";

/**
 * The `--effort` value that means "send no `--effort` flag at all; let agy
 * use whatever default the user configured on that machine" (plan 086 T5i).
 * It is the fourth accepted `--effort` value on `task` and `rescue`, and the
 * caller's way to reach the pre-1.4.0 behaviour `DEFAULT_AGY_EFFORT`
 * replaced. Since agy 1.2.11 it is also the value `resolveRequestEffort`
 * stores automatically when `--model` is given without `--effort`.
 */
export const AGY_DEFAULT_EFFORT = "agy-default";

/**
 * The four values `--effort` accepts on `task`, `rescue`, and `review`: agy's
 * own three ({@link AGY_EFFORTS}) plus the sentinel above. `vision` does not
 * use this; it exposes no `--effort` at all.
 */
export const EFFORT_CHOICES = [...AGY_EFFORTS, AGY_DEFAULT_EFFORT];

/**
 * Translate a resolved `--effort` value into what `runAgyPrint` should
 * forward: the sentinel becomes `undefined`, so the argv builder
 * (`buildAgyArgs`, agent-runtime.mjs) appends no `--effort` flag at all;
 * every other value, including `undefined`, passes through unchanged. The
 * stored job request keeps the sentinel itself — only the value handed to
 * the runtime call is translated.
 *
 * @param {string | undefined} effort
 * @returns {string | undefined}
 */
export function agyEffortArg(effort) {
  return effort === AGY_DEFAULT_EFFORT ? undefined : effort;
}

/**
 * Resolve the `--effort` value `task` and `rescue` store on the job request.
 * An explicit value wins. Without one: when a `--model` is present the
 * request stores the `agy-default` sentinel, so no `--effort` flag reaches
 * agy and the model id decides the level; without a model the plugin
 * default `medium` still applies, so a flag-less run stays reproducible
 * across machines.
 *
 * Why the model matters (agy 1.2.11, measured 2026-09-25; transcripts in the
 * `agy-1.2.11-20260925` measurement directory): agy now validates the pair.
 * A variant id such as `gemini-3.1-pro-high` accepts no `--effort` or only
 * its own level (`--model gemini-3.1-pro-high conflicts with
 * --effort=medium` otherwise, `raw-model-gemini-3.1-pro-high-effort-medium.txt`),
 * and a model without variants such as `claude-sonnet-4-6` rejects
 * `--effort` altogether (`--effort is not supported for model
 * "claude-sonnet-4-6"`, `raw-model-claude-sonnet-4-6-effort-medium.txt`), so
 * the old default broke every `--model` run that did not also name a
 * matching level (`probe-task-pro-default-effort.txt`, pre-fix; fixed and
 * reprobed as `probe-fixed-task-pro.txt`).
 *
 * @param {unknown} effortOption raw `--effort` value from the parser, if any
 * @param {string | undefined} model resolved `--model` value, if any
 * @returns {string}
 */
export function resolveRequestEffort(effortOption, model) {
  if (effortOption) return String(effortOption);
  return model ? AGY_DEFAULT_EFFORT : DEFAULT_AGY_EFFORT;
}

/**
 * Resolve the `--effort` value `review` stores on the job request (Task 4,
 * "Senate R4", 2026-09). Unlike {@link resolveRequestEffort} (`task`/
 * `rescue`), `review` has no plugin-side default: an absent `--effort`
 * resolves to `undefined`, with no fallback to {@link DEFAULT_AGY_EFFORT} or
 * to the `agy-default` sentinel. An explicit value, including the
 * `agy-default` sentinel itself, passes through unchanged and verbatim
 * (the parser's `valueChoices` already rejected anything else) — the
 * caller's given value is what gets stored on `request.effort` and
 * reported in `provenance.effort`, exactly as `task`/`rescue` already do
 * for their own explicit values. The sentinel-to-no-flag translation still
 * happens exactly once, downstream, via {@link agyEffortArg} (already
 * applied by `runForegroundJob` and by the background worker) — this
 * function has no second, separate translation step of its own.
 *
 * @param {unknown} effortOption raw `--effort` value from the parser, if any
 * @returns {string | undefined}
 */
export function resolveReviewEffort(effortOption) {
  return effortOption ? String(effortOption) : undefined;
}

/**
 * The maximum length, after trimming, `review`'s `--focus` accepts (Task 4,
 * "Senate R4", 2026-09).
 */
export const MAX_REVIEW_FOCUS_CHARS = 500;

/**
 * Validate and trim a `review` `--focus` value (Task 4, "Senate R4",
 * 2026-09): trimmed of surrounding whitespace; empty or whitespace-only, or
 * longer than {@link MAX_REVIEW_FOCUS_CHARS} after trimming, is a validation
 * error the caller reports via {@link reportInvalidFocus}. `--focus` is
 * never required and never derived from repository content — an absent
 * value is not an error, it is simply "no focus given".
 *
 * @param {unknown} focusOption raw `--focus` value from the parser, if any
 * @returns {{ focus: string | undefined, error: string | null }}
 */
export function resolveReviewFocus(focusOption) {
  if (focusOption === undefined) return { focus: undefined, error: null };
  const trimmed = String(focusOption).trim();
  if (trimmed === "") {
    return { focus: undefined, error: "invalid value for --focus: empty or whitespace-only" };
  }
  if (trimmed.length > MAX_REVIEW_FOCUS_CHARS) {
    return {
      focus: undefined,
      error: `invalid value for --focus: longer than ${MAX_REVIEW_FOCUS_CHARS} characters`,
    };
  }
  return { focus: trimmed, error: null };
}

/**
 * Report `review`'s `--focus` validation failure ({@link resolveReviewFocus}):
 * the plugin's own one-line reason on stderr, plus (Task 4, "Senate R4",
 * 2026-09, following the Task 3 pattern) one `invalid_input` `--json`
 * envelope when `json` is true.
 *
 * @param {string} message
 * @param {boolean} json
 * @returns {1}
 */
export function reportInvalidFocus(message, json) {
  process.stderr.write(`antigravity:review — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope("review", {
      status: "invalid_input",
      error: { code: "invalid_focus", phase: "validate", message },
    }),
    "",
    json,
  );
  return 1;
}

/**
 * agy argv for a validated `--mode` value; empty when the flag was not given.
 * Validation itself is the parser's job (`valueChoices`), so this never sees
 * an unknown value.
 *
 * @param {unknown} mode
 * @returns {string[]}
 */
export function agyModeArgs(mode) {
  return mode ? ["--mode", String(mode)] : [];
}

/**
 * Probe the agy binary once, before a verb collects a diff, writes a job
 * record or starts anything, returning both the one stderr line a verb
 * prints before it exits 1 (or `null` when agy can be spawned) and the
 * version agy itself reported (`null` only when the probe failed). The one
 * probe every delegating verb needs: a job's `provenance.agyVersion` (plan
 * 103 T2, "Senate R11", 2026-09) comes from this same probe, never a second
 * `agy --version` call. `setup` keeps its own wording and exit 2; this is
 * for the four verbs that run agy.
 *
 * @param {string} kind verb name (`review`, `rescue`, `task`, `vision`)
 * @param {{ bin?: string, probe?: typeof probeAgy }} [opts]
 * @returns {Promise<{ line: string | null, version: string | null }>}
 */
export async function probeAgyForVerb(kind, { bin = resolveAgyBin(), probe = probeAgy } = {}) {
  const result = await probe({ bin });
  if (result.ok) return { line: null, version: result.version ?? null };
  return {
    line: `antigravity:${kind} — \`agy\` is not on PATH (${result.reason}). Run /antigravity:setup.`,
    version: null,
  };
}

/** `rememberAgyVersion` writes no more often than this, per workspace. */
export const AGY_VERSION_REMEMBER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cache the agy version a successful {@link probeAgyForVerb} call just saw,
 * so `status` (with no job id) and `setup` can warn about a version outside
 * this plugin's measured range without probing agy themselves (Senate R2,
 * 2026-09). Called by `review`, `rescue`, `task`, and `vision` right after
 * their own probe succeeds. Never on `review --preview` (which returns
 * before probing at all), and never by `doctor` or `status`, which only read
 * this cache.
 *
 * Throttled to once per {@link AGY_VERSION_REMEMBER_INTERVAL_MS}, compared
 * against the cached `observedAt`, so a burst of foreground/background jobs
 * does not turn into a state-file write per job. A write failure (state
 * locked by a concurrent job) is swallowed: this cache is advisory, and
 * losing one update is cheaper than failing the verb that just succeeded.
 *
 * @param {string} workspaceRoot the resolved workspace root (`resolveWorkspaceRoot`)
 * @param {string | null | undefined} version the version {@link probeAgyForVerb} returned
 * @param {{ now?: () => Date }} [opts] `now` is injectable for tests
 * @returns {Promise<void>}
 */
export async function rememberAgyVersion(workspaceRoot, version, { now = () => new Date() } = {}) {
  if (!version) return;
  try {
    const seen = getConfig(workspaceRoot)?.agyVersionSeen;
    const elapsedMs = seen?.observedAt ? now().getTime() - new Date(seen.observedAt).getTime() : Infinity;
    if (elapsedMs < AGY_VERSION_REMEMBER_INTERVAL_MS) return;
    await setConfig(workspaceRoot, { agyVersionSeen: { version, observedAt: now().toISOString() } });
  } catch {
    // Advisory cache only. Never fail the verb over this.
  }
}

/**
 * Report a probe failure from {@link probeAgyForVerb}: the existing stderr
 * line, unchanged, plus (Task 3, "Senate R1", 2026-09) one `no_agy`
 * `--json` envelope when `json` is true. `line` already carries the
 * `antigravity:<kind> — ` prefix; `details.error.message` is that same line
 * with the prefix stripped, so it stays the plugin's own one-line reason.
 *
 * @param {string} kind verb name (`review`, `rescue`, `task`, `vision`)
 * @param {string} line the non-null `probeAgyForVerb(...).line`
 * @param {boolean} [json]
 * @returns {1} the exit code every caller returns on this path
 */
export function reportAgyUnavailable(kind, line, json) {
  process.stderr.write(`${line}\n`);
  const prefix = `antigravity:${kind} — `;
  const message = line.startsWith(prefix) ? line.slice(prefix.length) : line;
  outputCommandResult(
    createErrorEnvelope(kind, {
      status: "no_agy",
      error: { code: "agy_not_found", phase: "probe", message },
    }),
    "",
    Boolean(json),
  );
  return 1;
}

/** A thrown job-lookup message reports the job is not yet in the terminal
 * state the caller needs (`resolveResultJob`, job-control.mjs: "Job <id> is
 * still running/queued..."). Matched by shape, not owned by this module — the
 * one place every `status`/`result`/`cancel` job-lookup failure is classified
 * into a `state_error` envelope's `error.code` (Task 3, "Senate R1", 2026-09). */
const JOB_NOT_READY_RE = / is still (running|queued)\./;

/**
 * Classify a job-state lookup failure (job-control.mjs's `resolveResultJob`,
 * `resolveCancelableJob`, `buildSingleJobSnapshot`, or a `state.mjs` read)
 * into the `state_error` envelope's `error.code` and a safe one-line message
 * (Task 3, "Senate R1", 2026-09): a lock-contention timeout, a job that
 * exists but has not reached the caller's required state yet, or no matching
 * job at all. Table-driven on the message shape every throw site already
 * uses, never a new message format of its own.
 *
 * @param {unknown} err
 * @returns {{ code: string, message: string }}
 */
export function classifyStateError(err) {
  if (isFileLockTimeoutError(err)) {
    return { code: "state_locked", message: "job state is busy with another update; try again shortly" };
  }
  const message = err?.message ?? String(err);
  if (JOB_NOT_READY_RE.test(message)) return { code: "job_not_ready", message };
  return { code: "job_not_found", message };
}

/**
 * Report `task`/`rescue`'s "no task text provided" validation failure: the
 * existing stderr line, unchanged, plus (Task 3, "Senate R1", 2026-09) one
 * `invalid_input` `--json` envelope when `json` is true. The one message
 * both verbs print identically.
 *
 * @param {"task" | "rescue"} kind
 * @param {boolean} json
 * @returns {1}
 */
export function reportMissingTaskText(kind, json) {
  const message = "no task text provided. Pass a prompt or --conversation <id>.";
  process.stderr.write(`antigravity:${kind} — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope(kind, {
      status: "invalid_input",
      error: { code: "missing_task_text", phase: "validate", message },
    }),
    "",
    json,
  );
  return 1;
}

/**
 * Report a post-parse "flag A requires flag B" validation failure in the
 * exact shape `readCommandInput` already uses for a parser-level failure
 * (`args.mjs`'s `schema.conflicts`, e.g. "cannot combine --foreground and
 * --background"): one stderr line, prefixed, exit 1, no `--json` envelope on
 * any path (Task 7, "Senate R9", 2026-09). Split out for a dependency
 * `schema.conflicts` itself cannot express: two flags that must appear
 * together, not two flags that must never coexist.
 *
 * @param {string} kind verb name
 * @param {string} message
 * @returns {1}
 */
export function reportArgsValidationError(kind, message) {
  process.stderr.write(`antigravity:${kind} — ${message}\n`);
  return 1;
}

/**
 * Validate `--show-result`'s dependency on `--wait` (Task 7, "Senate R9",
 * 2026-09; all three verbs it applies to: `task`, `review`, `rescue`) and,
 * for `review`/`rescue` only, on `--background` too. `task` has no separate
 * "opt into background" flag of its own; its default already IS background,
 * so the equivalent failure there is `--foreground`: that mode
 * runs synchronously and has no `--wait` semantics at all, so it fails the
 * identical "requires --wait" message an absent `--wait` would, rather than
 * a second, `task`-only message.
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @param {"task" | "review" | "rescue"} kind
 * @returns {string | null} the message for {@link reportArgsValidationError}, or null when valid
 */
export function validateShowResultDependency(options, kind) {
  if (!options["show-result"]) return null;
  if (!options.wait || (kind === "task" && options.foreground)) {
    return "--show-result requires --wait";
  }
  if ((kind === "review" || kind === "rescue") && !options.background) {
    return "--show-result requires --background";
  }
  return null;
}

/**
 * The first stderr line for a foreground run that did not complete.
 * A run whose process never started names the spawn error; a run that
 * agy reported on keeps the status word.
 *
 * @param {string} kind
 * @param {{ status: string, spawnError?: string | null }} result
 * @returns {string}
 */
export function foregroundFailureLine(kind, result) {
  return result.spawnError
    ? `antigravity:${kind} — failed: ${result.spawnError}`
    : `antigravity:${kind} — failed (${result.status}).`;
}

/**
 * Verbs whose foreground `--conversation <id>` flag actually resumes a run
 * (`commands/task.md`, `commands/rescue.md`, `commands/review.md`,
 * `SKILL.md` all document it). `vision` has no `--conversation` flag at all,
 * so it is deliberately absent here (plan 086 T5k F1 item 3) — table-driven,
 * like the denial-remedy tables below (`READ_GRANTABLE_ACTIONS` and
 * friends), rather than derived from `kind` by pattern.
 */
const RESUMABLE_KINDS = new Set(["task", "rescue", "review"]);

/**
 * The one stderr line a denied foreground run of a resumable verb prints
 * beside its own denial line: the exact command a host can run to resume the
 * same agy conversation, with the id agy itself reported (plan 086 T5k F1
 * item 3 — closes the gap where a host was told to pass `--conversation
 * <id>` but never given one). `null` when the verb has no `--conversation`
 * flag, the run was not a denial, or agy never reported a conversation id
 * for it — never prints a line naming an id that does not exist.
 *
 * @param {string} kind
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {string | null}
 */
export function resumeHintLine(kind, result) {
  if (!RESUMABLE_KINDS.has(kind)) return null;
  if (!result?.denial || !result.agyConversationId) return null;
  return `antigravity:${kind} — resume with: /antigravity:${kind} --conversation ${result.agyConversationId}`;
}

/**
 * Explain an unfinished --wait without changing its exit code or envelope.
 *
 * @param {string} kind verb name
 * @param {import('./types.mjs').JobRecord | null | undefined} job
 * @returns {string | null}
 */
export function waitOutcomeLine(kind, job) {
  if (!job) return `antigravity:${kind} — job record vanished while waiting.`;
  if (job.status !== "running" && job.status !== "queued") return null;
  return `antigravity:${kind} — wait timed out; job ${job.id} is still ${job.status}. Run /antigravity:status ${job.id}.`;
}

/**
 * Map a terminal job status onto the exit code every verb shares: 0
 * completed, 2 cancelled, 1 otherwise (failed, missing, still running).
 *
 * @param {import('./types.mjs').JobStatus | undefined} status
 * @returns {number}
 */
export function exitCodeForJobStatus(status) {
  switch (status) {
    case "completed":
      return 0;
    case "cancelled":
      return 2;
    default:
      return 1;
  }
}

/**
 * Report a background job's start: the failure line and exit code 1 when it
 * never started, else the stable `--json`/markdown "queued" envelope. The
 * one background-start report `task.mjs`, `rescue.mjs` and `review.mjs`
 * each hand-wrote (item 19).
 *
 * Under `--show-result` (Task 7, "Senate R9", 2026-09) a successful dispatch
 * prints no envelope at all on stdout, in either mode: the caller is about
 * to wait for and print the completed job itself, so the dispatch-time
 * stdout stays empty and the one-line notice moves to stderr instead. A
 * failed dispatch (`job.status === "failed"`) is unaffected: the caller
 * never reaches `--wait` on that path, so it keeps reporting on stdout under
 * `--json` exactly as it always has.
 *
 * @param {string} kind verb name
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {{ json?: boolean, "show-result"?: boolean }} options
 * @returns {number | null} an exit code when the job failed to start, else
 *   null so the caller continues (e.g. to an optional `--wait`)
 */
export function reportQueuedJob(kind, job, options) {
  if (job.status === "failed") {
    process.stderr.write(`${foregroundFailureLine(kind, { spawnError: job.errorMessage })}\n`);
    outputCommandResult(
      createErrorEnvelope(kind, {
        status: "failed",
        jobId: job.id,
        error: {
          code: "worker_start_failed",
          phase: "run",
          message: job.errorMessage ?? "the worker failed to start",
        },
      }),
      "",
      Boolean(options.json),
    );
    return 1;
  }
  if (options["show-result"]) {
    process.stderr.write(`Background ${kind} started: ${job.id}\n`);
    return null;
  }
  const payload = createJsonEnvelope(kind, {
    status: "queued",
    jobId: job.id,
    details: {
      message: `Background ${kind} started. Run /antigravity:status ${job.id} to check progress.`,
    },
  });
  outputCommandResult(
    payload,
    `Background ${kind} started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
    Boolean(options.json),
  );
  return null;
}

/**
 * Report a `--request-id` dispatch that found the id already claimed with
 * the same request (Senate R12, 2026-09): the existing job's queued-style
 * envelope, carrying that job's current status and
 * `details.deduplicated: true`. Under `--show-result` the notice goes to
 * stderr instead, as {@link reportQueuedJob} does for a new job.
 *
 * @param {string} kind verb name
 * @param {import('./types.mjs').JobIndexEntry} job the existing job's index entry
 * @param {{ json?: boolean, "show-result"?: boolean, "request-id"?: string }} options
 * @returns {void}
 */
function reportDeduplicatedJob(kind, job, options) {
  const requestId = options["request-id"];
  if (options["show-result"]) {
    process.stderr.write(`Background ${kind} already started for request id ${requestId}: ${job.id}\n`);
    return;
  }
  const message = `Background ${kind} already started for request id ${requestId}: ${job.id}. ` +
    `Run /antigravity:status ${job.id} to check progress.`;
  outputCommandResult(
    createJsonEnvelope(kind, { status: job.status, jobId: job.id, details: { deduplicated: true, message } }),
    `Background ${kind} already started for request id ${requestId}: ${job.id}\n` +
      `Run /antigravity:status ${job.id} to check progress.\n`,
    Boolean(options.json),
  );
}

/**
 * Report a `--request-id` dispatch that found the id already claimed by a
 * different request (Senate R12, 2026-09): one stderr line plus the
 * `invalid_input` / `request_id_conflict` envelope under `--json`. No job
 * was created and nothing is retried.
 *
 * @param {string} kind verb name
 * @param {string} existingJobId
 * @param {{ json?: boolean, "request-id"?: string }} options
 * @returns {1}
 */
function reportRequestIdConflict(kind, existingJobId, options) {
  const message = `--request-id ${options["request-id"]} is already used by job ${existingJobId} for a different request`;
  process.stderr.write(`antigravity:${kind} — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope(kind, {
      status: "invalid_input",
      error: { code: "request_id_conflict", phase: "validate", message },
      details: { existingJobId },
    }),
    "",
    Boolean(options.json),
  );
  return 1;
}

/**
 * Report what {@link startBackgroundJob} returned, for `task` and
 * `rescue --background`: a new job goes through {@link reportQueuedJob}
 * unchanged; a `--request-id` claim that found an existing job reports it
 * as deduplicated or as a conflict (Senate R12, 2026-09).
 *
 * @param {string} kind verb name
 * @param {Awaited<ReturnType<typeof startBackgroundJob>>} started
 * @param {{ json?: boolean, "show-result"?: boolean, "request-id"?: string }} options
 * @returns {{ exit: number | null, jobId: string | null }} `exit` is null
 *   when the caller continues (e.g. to an optional `--wait` on `jobId`)
 */
export function reportBackgroundStart(kind, started, options) {
  const claim = started.requestClaim;
  if (!claim) return { exit: reportQueuedJob(kind, started.job, options), jobId: started.job.id };
  if (claim.outcome === "conflict") return { exit: reportRequestIdConflict(kind, claim.jobId, options), jobId: null };
  reportDeduplicatedJob(kind, claim.job, options);
  return { exit: null, jobId: claim.jobId };
}

/**
 * Print the finished job's raw output on stdout when a text-mode `--wait`
 * completed: `task --wait`'s own behaviour since before `--show-result`
 * existed, and (Task 7, "Senate R9", 2026-09) also `review`/`rescue --wait
 * --show-result`'s completed-text-mode behaviour. A no-op under `--json`, for
 * any status but `completed`, or when the stored result carries no
 * `rawOutput`. `final` may be `null` (the job record vanished while
 * waiting); optional chaining makes that the same no-op as any other
 * non-completed status, rather than a thrown error.
 *
 * @param {import('./types.mjs').JobRecord | null} final
 * @param {boolean} json
 * @returns {void}
 */
export function printCompletedRawOutput(final, json) {
  if (json || final?.status !== "completed" || !final.result?.rawOutput) return;
  process.stdout.write(final.result.rawOutput);
}

/**
 * The `details` for a `--show-result` completion envelope: the same
 * projection `result <id> --json` builds (`buildResultDetails`, shared via
 * `job-result.mjs`), plus the same `deniedActions` (with remedy) and
 * `agyPrintTimeout` keys that envelope adds on top (Task 7, "Senate R9",
 * 2026-09). `final` (the terminal `JobRecord` `waitForJob` returns) plays
 * both the `job` and `stored` role `buildResultDetails` expects: unlike
 * `result.mjs`'s index-entry-plus-detail-file split, a background wait's
 * `waitForJob` already reads the one complete per-job file, so there is no
 * second, thinner record to merge in. No `--head`/`--tail` cut ever applies
 * here (`--show-result` takes no such flag), so the shared helper's default
 * `{ truncated: false }` cut is always what this passes.
 *
 * @param {import('./types.mjs').JobRecord} final a job with `status: "completed"`
 * @returns {object}
 */
function buildShowResultCompletedDetails(final) {
  const deniedList = deniedActionsWithRemedy(final.result?.deniedActions, final.kind);
  const agyPrintTimeout = final.result?.agyPrintTimeout ?? null;
  return {
    ...buildResultDetails(final, final, { truncated: false }),
    ...(deniedList ? { deniedActions: deniedList } : {}),
    ...(agyPrintTimeout ? { agyPrintTimeout } : {}),
  };
}

/**
 * The `details.error.message` for a `--show-result` wait-timeout envelope
 * (job still `queued`/`running` when the wait's own deadline passed): the
 * same one-line reason {@link waitOutcomeLine} already gives the text-mode
 * stderr path, with its own `antigravity:<kind>` prefix stripped, the same
 * "strip the stderr line's own prefix for JSON reuse" convention
 * `foregroundErrorMessage` uses below.
 *
 * @param {string} kind
 * @param {import('./types.mjs').JobRecord} final a job still `queued` or `running`
 * @returns {string}
 */
function showResultTimeoutMessage(kind, final) {
  const line = waitOutcomeLine(kind, final);
  const prefix = `antigravity:${kind} — `;
  if (line?.startsWith(prefix)) return line.slice(prefix.length);
  return line ?? `wait timed out; job ${final.id} is still ${final.status}.`;
}

/**
 * Build the one `--show-result --json` envelope for an awaited background
 * job (Task 7, "Senate R9", 2026-09): `completed` reuses `result <id>
 * --json`'s own details shape; `failed`/`cancelled` are the Task 3 error
 * envelope with `error.code: "job_failed"`/`"job_cancelled"`; a job still
 * `queued`/`running` (the wait's own deadline passed, not the job) is
 * `error.code: "wait_timeout"` and never reports completion. A vanished job
 * record (`final` is `null`) is reported the same way a stored failure is,
 * since there is no terminal status left to represent.
 *
 * @param {string} kind verb name
 * @param {string} jobId the id the caller waited on (used when `final` is `null`)
 * @param {import('./types.mjs').JobRecord | null} final
 * @returns {import('./types.mjs').JsonEnvelopeV1}
 */
function buildShowResultEnvelope(kind, jobId, final) {
  if (!final) {
    // phase "wait", not "run": the job record itself vanished while this
    // call was waiting on it, so there is no run outcome to report; reusing
    // "job_failed" still names the terminal shape correctly (a failure, not
    // a timeout or a cancellation).
    return createErrorEnvelope(kind, {
      status: "failed",
      jobId,
      error: { code: "job_failed", phase: "wait", message: "job record vanished while waiting." },
    });
  }
  if (final.status === "completed") {
    return createJsonEnvelope(kind, {
      status: "completed",
      jobId: final.id,
      answer: typeof final.result?.rawOutput === "string" ? final.result.rawOutput : null,
      details: buildShowResultCompletedDetails(final),
    });
  }
  if (final.status === "failed" || final.status === "cancelled") {
    return createErrorEnvelope(kind, {
      status: final.status,
      jobId: final.id,
      error: {
        code: final.status === "cancelled" ? "job_cancelled" : "job_failed",
        phase: "run",
        message: final.errorMessage ?? final.healthMessage ?? `job ${final.id} ${final.status}.`,
      },
    });
  }
  return createErrorEnvelope(kind, {
    status: final.status,
    jobId: final.id,
    error: { code: "wait_timeout", phase: "wait", message: showResultTimeoutMessage(kind, final) },
  });
}

/**
 * The `--show-result` text-mode tail (Task 7, "Senate R9", 2026-09): a
 * `completed` job prints its stored `rawOutput` on stdout (the usage
 * trailer, when measured, is printed by the caller, see
 * {@link reportShowResultOutcome}, the same way it always precedes a
 * completed answer, in `--json` or not); a `failed` job prints its own
 * stored reason on stderr and nothing on stdout; `cancelled` prints nothing
 * at all; a job still `queued`/`running` (the wait timed out) prints the
 * existing `wait timed out` line, unchanged. Every branch is silent on the
 * stream it does not own. There is no envelope in text mode.
 *
 * @param {string} kind verb name
 * @param {import('./types.mjs').JobRecord | null} final
 * @returns {void}
 */
function reportShowResultText(kind, final) {
  if (!final) {
    process.stderr.write(`antigravity:${kind} — job record vanished while waiting.\n`);
    return;
  }
  if (final.status === "completed") {
    printCompletedRawOutput(final, false);
    return;
  }
  if (final.status === "failed") {
    const message = final.errorMessage ?? final.healthMessage ?? `job ${final.id} failed.`;
    process.stderr.write(`antigravity:${kind} — ${message}\n`);
    return;
  }
  if (final.status === "cancelled") return;
  const line = waitOutcomeLine(kind, final);
  if (line) process.stderr.write(`${line}\n`);
}

/**
 * `--show-result`'s own background-wait tail (Task 7, "Senate R9", 2026-09):
 * the usage trailer on a completed job (unconditional on `--json`, matching
 * every other completed path in this module), then exactly one `--json`
 * envelope on stdout via {@link buildShowResultEnvelope}, or the text-mode
 * report via {@link reportShowResultText}, never both, and never the
 * dispatch-time queued envelope `reportQueuedJob` already suppressed for
 * this flag. Split out of {@link waitAndReport} so that function's own two
 * branches (the flag on, and the pre-existing behaviour it must stay
 * byte-identical to) each read as one call.
 *
 * @param {string} kind verb name
 * @param {string} jobId
 * @param {import('./types.mjs').JobRecord | null} final
 * @param {boolean} json
 * @returns {number}
 */
function reportShowResultOutcome(kind, jobId, final, json) {
  if (final?.status === "completed") {
    printMeasuredUsageTrailer(final.result?.usage ?? null);
    reportFindingsWarning(kind, storedFindingsDetails(final));
  }
  if (json) {
    outputCommandResult(buildShowResultEnvelope(kind, jobId, final), "", true);
  } else {
    reportShowResultText(kind, final);
  }
  return exitCodeForJobStatus(final?.status);
}

/**
 * Await a background job's terminal state and report it: the one
 * background-wait tail `task.mjs`, `rescue.mjs` and `review.mjs` share
 * (item 19; extended for `--show-result` in Task 7, "Senate R9", 2026-09).
 *
 * Without `showResult` this is byte-identical to the pre-Task-7 behaviour:
 * print the wait-timeout line (if any), map the outcome to an exit code,
 * and, `task` only, print the completed job's raw output on stdout in
 * text mode (`printCompletedRawOutput`; `review`/`rescue` never have,
 * before or after this task). With `showResult` this reports through
 * {@link reportShowResultOutcome} instead, for all three verbs alike.
 *
 * @param {string} kind verb name
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {typeof waitForJob} wait
 * @param {{ json?: boolean, showResult?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function waitAndReport(kind, workspaceRoot, jobId, wait, { json = false, showResult = false } = {}) {
  const final = await wait(workspaceRoot, jobId);
  if (showResult) return reportShowResultOutcome(kind, jobId, final, json);
  if (final?.status === "completed") printMeasuredUsageTrailer(final.result?.usage ?? null);
  const line = waitOutcomeLine(kind, final);
  if (line) process.stderr.write(`${line}\n`);
  if (kind === "task") {
    if (!final) return 1;
    printCompletedRawOutput(final, json);
  }
  return exitCodeForJobStatus(final?.status);
}

/**
 * Resolve the current session id (or `null` if unset).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function currentSessionId(env = process.env) {
  return env[SESSION_ID_ENV] ?? null;
}

/**
 * agy tool ids where `--add-dir <dir>` grants read access, bounded to that
 * directory, read-only, for the run (agy 1.1.24, measured: `read_file` and
 * similar). Table-driven (item 3): a remedy is never derived by matching an
 * action id against a naming pattern.
 */
const READ_GRANTABLE_ACTIONS = new Set([
  "read_file", "list_dir", "find_by_name", "grep_search", "view_file", "read_resource",
]);

/** agy tool ids where `--mode accept-edits` grants file edits inside the
 * workspace for the run. */
const EDIT_GRANTABLE_ACTIONS = new Set([
  "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit",
]);

/** `vision` never plumbs `--add-dir` on purpose: `read_file` on an image
 * yields bytes, not pixels, so the fix is always the MCP `view_image` tool,
 * independent of which action was actually denied. */
const VISION_DENIAL_REMEDY =
  "vision: the runtime must use the `view_image` MCP tool, not `read_file`.";

/**
 * One short sentence naming the remedy for a headless denial of `action` on
 * a `verb` job (item 3: table-driven, no regex on free text).
 *
 * This lives here, not in agent-runtime, because the runtime is the
 * verb-agnostic spawn chokepoint and this module is already the one place
 * that turns a runtime result into verb-facing job fields (`healthMessage`,
 * `recommendedAction`); every verb path, foreground or worker, passes
 * through it with the job `kind` in hand.
 *
 * `vision` always gets its fixed hint regardless of `action` (see
 * {@link VISION_DENIAL_REMEDY}). For every other verb: a read-type action
 * (`read_file` and similar) gets `--add-dir <dir>` — the only headless read
 * grant that works on agy 1.1.24, bounded to that directory, read-only, per
 * run; an edit-type action gets `--mode accept-edits`; everything else
 * (`read_url`, command execution, MCP tools — no in-plugin grant exists for
 * these) gets a plain statement naming the action and pointing at the
 * host's own documented options. Never suggests
 * `--dangerously-skip-permissions` and never implies a retry.
 *
 * @param {string} action agy tool id (e.g. "read_file", "read_url")
 * @param {string} verb job kind (`rescue`, `task`, `vision`, `review`)
 * @returns {string}
 */
export function denialRemedy(action, verb) {
  if (verb === "vision") return VISION_DENIAL_REMEDY;
  if (READ_GRANTABLE_ACTIONS.has(action)) {
    return "Pass --add-dir <dir> to grant read access to that directory for this run.";
  }
  if (EDIT_GRANTABLE_ACTIONS.has(action)) {
    return "Pass --mode accept-edits to grant file edits inside the workspace for this run.";
  }
  return `Headless runs cannot grant "${action}"; the host must run this step itself.`;
}

/**
 * Project a raw `deniedActions` list (`{ action, displayName, target,
 * source }`, see agent-runtime.mjs#mergeDeniedActions) into the
 * `{ action, displayName, target, remedy }` shape every output path renders
 * (item 4; `target` added plan 086 T3 item 2), using {@link denialRemedy}
 * with the job's own `kind`. `null` when there is nothing to project, so a
 * caller can skip an empty `details` key the same way `warningDetails` does.
 *
 * @param {import('./types.mjs').DeniedAction[] | null | undefined} deniedActions
 * @param {string} kind job kind (`rescue`, `task`, `vision`, `review`)
 * @returns {import('./types.mjs').DeniedActionWithRemedy[] | null}
 */
export function deniedActionsWithRemedy(deniedActions, kind) {
  if (!Array.isArray(deniedActions) || deniedActions.length === 0) return null;
  return deniedActions.map(({ action, displayName, target }) => ({
    action,
    displayName: displayName ?? null,
    target: target ?? null,
    remedy: denialRemedy(action, kind),
  }));
}

/**
 * Fold one remedy line per denied action into a starved-by-denial result so
 * every reader of `result.stderr` (the verb's failure print, the stored
 * `errorMessage`) sees the remedy next to the reason. Falls back to
 * `result.denial.tool` alone when `result.deniedActions` is absent (a test
 * double, or a `RuntimeResult` built before this field existed). Returns
 * the same object.
 *
 * When an entry's `target` is known (plan 086 T3 item 2) the line names it
 * via {@link formatDeniedActionLabel} before the remedy sentence
 * (`agent-runtime: read_url (ReadUrlContent) for "example.com": <remedy>`);
 * when it is not, the line stays the exact 1.3.0 text
 * (`agent-runtime: <remedy>`) — item 6's "1.3.0 behaviour with no target
 * present is unchanged".
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {string} kind job kind
 * @returns {import('./types.mjs').RuntimeResult}
 */
export function applyDenialHint(result, kind) {
  if (result?.status !== "failed" || !result.denial) return result;
  const actions = Array.isArray(result.deniedActions) && result.deniedActions.length
    ? result.deniedActions
    : [{ action: result.denial.tool }];
  for (const entry of actions) {
    const remedy = denialRemedy(entry.action, kind);
    const line = entry.target ? `${formatDeniedActionLabel(entry)}: ${remedy}` : remedy;
    result.stderr = `${result.stderr ?? ""}\nagent-runtime: ${line}`;
  }
  return result;
}

/**
 * Echo one remedy line per denied action to stderr on a completed run that
 * still carries denials (item 4's foreground "warning text"):
 * `reportWarnings` already echoes agy's own denial line(s) verbatim; this
 * adds the plugin's own remedy underneath, one per action.
 *
 * When `target` is known (plan 086 T3 item 2) the line names it via
 * {@link formatDeniedActionLabel} (`read_url (ReadUrlContent) for
 * "example.com"`); when it is not, the line stays the exact 1.3.0 text
 * (`"<action>"`) — item 6's "1.3.0 behaviour with no target present is
 * unchanged". `target` is model-chosen tool-parameter text, so the whole
 * line runs through {@link redactBypassFlag} before it reaches this
 * function's own stderr (plan 086 T5e F3): a denied target that IS the
 * bypass flag must not print that flag on the plugin's own stderr, even
 * though this line never carries agy's "Alternatively, ..." suggestion
 * `stripBypassAdvice` is built to catch.
 *
 * @param {string} kind
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {void}
 */
export function reportDeniedActionHints(kind, result) {
  const list = deniedActionsWithRemedy(result?.deniedActions, kind);
  if (!list) return;
  for (const entry of list) {
    const label = entry.target ? formatDeniedActionLabel(entry) : `"${entry.action}"`;
    process.stderr.write(redactBypassFlag(`antigravity:${kind} — denied ${label}: ${entry.remedy}\n`));
  }
}

/**
 * Map a `runAgyPrint` result.status onto a job status persisted on disk.
 *
 * `auth_required` and `timeout` are surfaced as `failed` with a diagnostic
 * `healthStatus` set so the status command can render the OAuth URL. The
 * one mapping used by both the foreground path (below) and the background
 * worker (`_worker.mjs`) — before 076-T6 the worker had its own simpler
 * copy that skipped the `timeout` case's retry hint (item 16).
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {string} kind
 * @returns {{ status: import('./types.mjs').JobStatus, healthStatus?: import('./types.mjs').HealthStatus,
 *   healthMessage?: string, recommendedAction?: string | null }}
 */
export function deriveJobStatus(result, kind) {
  switch (result.status) {
    case "completed":
      return { status: "completed" };
    case "cancelled":
      return { status: "cancelled" };
    case "auth_required":
      return {
        status: "failed",
        healthStatus: "auth_required",
        healthMessage:
          "Antigravity is not authenticated. Complete the OAuth flow shown above, then re-run.",
        recommendedAction: "Run /antigravity:setup to complete the OAuth flow.",
      };
    case "timeout":
      return {
        status: "failed",
        healthStatus: "failed",
        healthMessage: result.errorMessage ?? "agy --print timed out before finishing.",
        recommendedAction: "Re-run the command, optionally with --background. Increase ANTIGRAVITY_AGY_TIMEOUT_MS for a longer run; background work uses the same budget.",
      };
    case "failed":
    default:
      if (result.denial) {
        return {
          status: "failed",
          healthStatus: "failed",
          healthMessage:
            `agy auto-denied the "${result.denial.tool}" tool (headless mode cannot prompt) and produced no output.`,
          recommendedAction: denialRemedy(result.denial.tool, kind),
        };
      }
      return {
        status: "failed",
        healthStatus: "failed",
        // The runtime's own safe reason (redacted, one line), when it has
        // one: `result --json` names it as `details.error.message`.
        ...(result.errorMessage ? { healthMessage: result.errorMessage } : {}),
      };
  }
}

/**
 * Build the `provenance` object every job record carries from creation
 * (plan 103 T2, "Senate R11", 2026-09): enough for a later reader to
 * reproduce the run's settings, and nothing the caller gave the model — no
 * prompt, workspace path, image path, `extraArgs` content, or tool list.
 * `pluginVersion` is this plugin's own running version
 * (`scripts/lib/update.mjs#readRunningVersion`); every other field is a
 * plain projection off the caller's already-built `request` (itself already
 * scrubbed of free text by the verb) or the `agyVersion` the caller's own
 * {@link probeAgyForVerb} call already ran. `model`/`effort` are `null` for
 * a verb that has none (`review`); `mode` defaults to `"print"` and
 * `addDirCount` to `0` when the request carries neither.
 *
 * @param {{ agyVersion: string | null, request: import('./types.mjs').JobRequest | null,
 *   requestedAt: string }} args
 * @returns {import('./types.mjs').JobProvenance}
 */
function buildJobProvenance({ agyVersion, request, requestedAt }) {
  return {
    pluginVersion: readRunningVersion(),
    agyVersion: agyVersion ?? null,
    model: request?.model ?? null,
    effort: request?.effort ?? null,
    mode: request?.mode ?? "print",
    addDirCount: Array.isArray(request?.addDirs) ? request.addDirs.length : 0,
    requestedAt,
  };
}

/**
 * @typedef {{ workspaceRoot: string, kind: import('./types.mjs').JobKind,
 *   title?: string | null, request?: import('./types.mjs').JobRequest | null,
 *   conversationId?: string | null, env?: NodeJS.ProcessEnv,
 *   agyVersion?: string | null }} TrackedJobOptions
 */

/**
 * Create a tracked job record on disk.
 *
 * Returns the job index entry. The detailed payload (request, result,
 * stdout) lives in the per-job file written via `writeJobFile`.
 *
 * @param {TrackedJobOptions} options
 * @returns {Promise<import('./types.mjs').JobIndexEntry>}
 */
export async function createTrackedJob(options) {
  const { job, detail } = buildTrackedJob(options);
  await patchJob(options.workspaceRoot, job.id, detail);
  appendJobLog(options.workspaceRoot, job.id, `[job] created kind=${job.kind}`);
  return job;
}

/**
 * {@link createTrackedJob} for a caller that already holds the workspace
 * mutex: `state.mjs#claimRequestId` runs this as its `createJob` callback,
 * so the `--request-id` claim and the job it creates share one locked
 * critical section (Senate R12, 2026-09). Same record, same log line.
 *
 * @param {TrackedJobOptions} options
 * @returns {import('./types.mjs').JobIndexEntry}
 */
function createTrackedJobUnlocked(options) {
  const { job, detail } = buildTrackedJob(options);
  patchJobStateUnlocked(options.workspaceRoot, job.id, detail, stripDetail(detail));
  appendJobLog(options.workspaceRoot, job.id, `[job] created kind=${job.kind}`);
  return job;
}

/**
 * The new job's index entry and its full detail record (the entry plus
 * `request` and a `null` `result`), not yet written anywhere.
 *
 * @param {TrackedJobOptions} options
 * @returns {{ job: import('./types.mjs').JobIndexEntry, detail: import('./types.mjs').JobRecord }}
 */
function buildTrackedJob({
  workspaceRoot,
  kind,
  title,
  request = null,
  conversationId = null,
  env = process.env,
  agyVersion = null,
}) {
  const id = newJobId();
  const now = new Date().toISOString();
  const sessionId = currentSessionId(env);
  const job = {
    id,
    kind,
    title: title ?? null,
    status: "queued",
    phase: "queued",
    sessionId,
    pid: null,
    workerPid: null,
    agyPid: null,
    conversationId,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    logFile: resolveJobLogFile(workspaceRoot, id),
    provenance: buildJobProvenance({ agyVersion, request, requestedAt: now }),
  };
  return { job, detail: { ...job, request, result: null } };
}

/**
 * Patch and persist a job index + file.
 *
 * @param {string} workspaceRoot the resolved workspace root
 * @param {string} jobId
 * @param {Partial<import('./types.mjs').JobRecord>} patch
 * @returns {Promise<import('./types.mjs').JobRecord>}
 */
export async function patchJob(workspaceRoot, jobId, patch) {
  return patchJobState(workspaceRoot, jobId, patch, stripDetail(patch));
}

/** Strip detail-only fields (request/result/stdout) from a patch destined for the index. */
function stripDetail(patch) {
  const rest = { ...patch };
  delete rest.request;
  delete rest.result;
  delete rest.stdout;
  return rest;
}

/**
 * Run an agy --print call in the FOREGROUND while tracking it as a job.
 *
 * The job is created with status=queued, transitioned to running, and
 * resolved to completed/failed/cancelled based on the runAgyPrint result.
 *
 * @param {import('./types.mjs').ProcessRequest & { workspaceRoot: string,
 *   kind: string, title?: string | null, request?: object | null,
 *   env?: NodeJS.ProcessEnv, agyVersion?: string | null }} options
 * @returns {Promise<{ job: import('./types.mjs').JobRecord, result: import('./types.mjs').RuntimeResult }>}
 */
export async function runForegroundJob({
  workspaceRoot,
  kind,
  title,
  prompt,
  mode = "print",
  conversationId,
  addDirs = [],
  model,
  effort,
  outputFormat,
  extraArgs = [],
  jsonSchemaPath,
  cwd,
  request = null,
  env = process.env,
  agyVersion = null,
  onStdout,
  onStderr,
  onText,
} = {}) {
  const job = await createTrackedJob({
    workspaceRoot,
    kind,
    title,
    request,
    conversationId,
    env,
    agyVersion,
  });

  const startedAt = new Date().toISOString();
  await patchJob(workspaceRoot, job.id, {
    status: "running",
    phase: "running",
    startedAt,
    pid: process.pid,
    workerPid: process.pid,
  });
  appendJobLog(workspaceRoot, job.id, `[job] running (foreground) pid=${process.pid}`);

  let result;
  const activity = createJobActivityRecorder(workspaceRoot, job.id);
  try {
    result = await runAgyPrint({
      prompt,
      mode,
      conversationId,
      addDirs,
      model,
      effort: agyEffortArg(effort),
      outputFormat,
      extraArgs,
      jsonSchemaPath,
      cwd: cwd ?? workspaceRoot,
      env,
      timeoutMs: agyTimeoutMs(env),
      onStdout,
      onStderr,
      onText: (delta) => {
        activity.onText();
        onText?.(delta);
      },
      onSpawn: async ({ pid }) => {
        await patchJob(workspaceRoot, job.id, { agyPid: pid ?? null });
      },
    });
    await activity.finish();
  } catch (err) {
    await activity.finish().catch(() => {});
    const completedAt = new Date().toISOString();
    appendJobLog(workspaceRoot, job.id, `[job] crashed: ${err?.message ?? err}`);
    await patchJob(workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      completedAt,
      errorMessage: err?.message ?? String(err),
      healthStatus: "failed",
    });
    throw err;
  } finally {
    await activity.finish();
  }

  const completedAt = new Date().toISOString();
  applyDenialHint(result, kind);
  const derived = deriveJobStatus(result, kind);
  const { answerBytes, answerLines } = deriveAnswerSize(result.stdout);
  await patchJob(
    workspaceRoot,
    job.id,
    buildTerminalJobPatch({ result, derived, completedAt, answerBytes, answerLines }),
  );
  appendJobLog(
    workspaceRoot,
    job.id,
    `[job] ${derived.status} exit=${result.exitCode} status=${result.status}`,
  );
  return { job: { ...job, status: derived.status }, result };
}

/**
 * The terminal `patchJob` payload `runForegroundJob` writes once a run
 * settles: every field is a plain default or projection off `result`/
 * `derived`, with no control flow of its own worth inlining at the call
 * site. Split out so `runForegroundJob` itself stays under the complexity
 * ceiling (each `??`/ternary here is one branch).
 *
 * @param {{ result: import('./types.mjs').RuntimeResult, derived: ReturnType<typeof deriveJobStatus>,
 *   completedAt: string, answerBytes: number | null, answerLines: number | null }} args
 * @returns {Partial<import('./types.mjs').JobRecord>}
 */
function buildTerminalJobPatch({ result, derived, completedAt, answerBytes, answerLines }) {
  return {
    status: derived.status,
    phase: derived.status,
    completedAt,
    exitCode: result.exitCode,
    summary: deriveSummary(result),
    oauthUrl: result.oauthUrl ?? null,
    errorMessage: storedErrorMessage(result, result.status === "failed"),
    healthStatus: derived.healthStatus ?? null,
    healthMessage: derived.healthMessage ?? null,
    recommendedAction: derived.recommendedAction ?? null,
    answerBytes,
    answerLines,
    deniedActions: result.deniedActions ?? null,
    deniedActionsCount: Array.isArray(result.deniedActions) ? result.deniedActions.length : 0,
    agyPrintTimeout: result.agyPrintTimeout ?? null,
    // Top-level, not only nested under `result` (plan 086 T5k F1 item 1):
    // agy's own conversation id, present whenever agy reported one, including
    // a failed or denied run — distinct from the top-level `conversationId`
    // field, which is the id the *caller* passed in via `--conversation`.
    // Lifting it to the top level (mirroring `deniedActionsCount` above)
    // means `jobIndexProjection` (state.mjs) keeps it on the index entry too,
    // so `status --json`'s job list carries it without a per-job disk read.
    agyConversationId: result.agyConversationId ?? null,
    result: buildStoredResult(result),
  };
}

/**
 * The `result` field persisted on a job record once a run reaches a
 * terminal state — the one stored-result projection used by both the
 * foreground path above and the background worker (`_worker.mjs`); before
 * 076-T6 each hand-wrote its own copy and only the worker's stored
 * `agyConversationId` (item 16).
 *
 * `reportedModel` (plan 103 T2, "Senate R11", 2026-09) is taken from agy's
 * own `result` event when that event carries a model field. Measured against
 * agy 1.2.11 and 1.2.12 (`agy-1.2.11-20260925/`, `agy-1.2.12-20260927/`
 * transcript directories, including `probe-json-schema.txt` and
 * `probe-background-lifecycle.txt`), the `result` event never carries one —
 * only agy's own `status --json` model listing and request-side argv do — so
 * `result.reportedModel` is always absent today and this stays `null`. It is
 * never derived from the model the caller requested (`request.model`); if a
 * future agy version adds the field, `agent-runtime.mjs` would need to parse
 * it onto `RuntimeResult.reportedModel` for this line to stop being `null`.
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {import('./types.mjs').JobResult}
 */
export function buildStoredResult(result) {
  return {
    rawOutput: result.stdout,
    stderr: result.stderr,
    status: result.status,
    exitCode: result.exitCode,
    oauthUrl: result.oauthUrl ?? null,
    usage: result.usage ?? null,
    durationSeconds: result.durationSeconds ?? null,
    agyConversationId: result.agyConversationId ?? null,
    warnings: result.warnings ?? [],
    deniedActions: result.deniedActions ?? null,
    agyPrintTimeout: result.agyPrintTimeout ?? null,
    reportedModel: result.reportedModel ?? null,
    // Senate R7 (2026-09): agy's `--json-schema` answer as JSON text, `null`
    // when agy sent none. Validated at read time (review-findings.mjs).
    structuredRaw: structuredRawText(result.structured),
  };
}

/**
 * Print the one findings warning line (`review --findings-json`, Senate R7,
 * 2026-09) when `details` carries a `findingsStatus` other than `valid`. A
 * no-op for every other run, which has no such key.
 *
 * @param {string} kind
 * @param {{ findingsStatus?: string, findingsError?: string }} details
 * @returns {void}
 */
function reportFindingsWarning(kind, details) {
  const line = findingsWarningLine(kind, details);
  if (line) process.stderr.write(`${line}\n`);
}

/**
 * Print agy's measured token usage to stderr in the plugin's one stable
 * shape (docs/COMPATIBILITY.md, "Usage trailer"), when `usage.total_tokens`
 * is a number. A no-op otherwise — the plugin never estimates missing usage
 * and never emits the line when a measured total is absent. The one helper
 * for `finishForeground`'s foreground tail (all four verbs) and the shared
 * background-wait tail (`waitAndReport` below); `result.mjs` and
 * `vision.mjs` each hand-wrote a copy of this exact line before plan 103 T2
 * ("Senate R11", 2026-09).
 *
 * @param {import('./types.mjs').AgyUsage | null | undefined} usage
 * @returns {void}
 */
export function printMeasuredUsageTrailer(usage) {
  if (!usage || typeof usage.total_tokens !== "number") return;
  process.stderr.write(
    `usage: total=${usage.total_tokens} in=${usage.input_tokens ?? "?"} ` +
      `out=${usage.output_tokens ?? "?"}\n`,
  );
}

/**
 * The shared foreground tail: auth-required print, failure print, warnings,
 * the stable `--json` envelope, and the exit code. `review.mjs`,
 * `rescue.mjs`, `task.mjs` and `vision.mjs` each hand-wrote this same
 * sequence after `runForegroundJob` resolves, differing only in their
 * `details`/top-level envelope fields (item 16).
 *
 * `extraDetails` is merged before `warningDetails(result)` so a caller's
 * own keys keep their original position and a warning can never shadow
 * one; `extraFields` covers additional stable top-level envelope fields
 * (only `vision`'s `imagePaths`/`model`, docs/COMPATIBILITY.md); a
 * `beforeAnswer` callback runs right after `reportWarnings` and before the
 * envelope is built, for a caller-specific stderr line with no shared home.
 * The measured-usage trailer itself (plan 103 T2, "Senate R11", 2026-09) is
 * no longer one of those callbacks: {@link printMeasuredUsageTrailer} runs
 * here for every kind whenever `result.usage.total_tokens` is a number —
 * `vision.mjs` used to pass its own copy of that line as `beforeAnswer`.
 * `resultDetails` (Senate R7, 2026-09) derives more `details` keys from the
 * completed `result` itself (`review --findings-json`'s findings fields);
 * they sit next to `extraDetails`, and a non-valid `findingsStatus` among
 * them prints one warning line on stderr.
 *
 * `extraStderrLines`/`renderedSuffix` (Task 14, "Senate R8", 2026-09) are
 * the same optional-line pattern for a caller whose extra line depends on
 * `ownDetails` (the merged `extraDetails`/`resultDetails` — `review
 * --check-locations`'s summary line needs the `locationCheck` counts
 * `resultDetails` just computed) rather than on `result` alone:
 * `extraStderrLines` prints to stderr, `renderedSuffix` appends to the
 * printed markdown ({@link appendRenderedLines}) — `answer` in the `--json`
 * envelope is never touched by either. Absent for every caller that has
 * none, so `finishForeground`'s existing callers are unchanged.
 *
 * @param {string} kind verb name (`review`, `rescue`, `task`, `vision`)
 * @param {{ id: string }} job
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {{ json: boolean, extraDetails?: object, extraFields?: object, beforeAnswer?: () => void,
 *   resultDetails?: (result: import('./types.mjs').RuntimeResult) => object,
 *   extraStderrLines?: (result: import('./types.mjs').RuntimeResult, ownDetails: object) => string[],
 *   renderedSuffix?: (result: import('./types.mjs').RuntimeResult, ownDetails: object) => string[] }} [options]
 * @returns {number} the verb's exit code
 */
/**
 * The `error.code` for a non-completed `finishForeground` result (Task 3,
 * "Senate R1", 2026-09): `cancelled`/`auth_required`/`timeout` mirror
 * `result.status` verbatim (there is only one reason for each); a `failed`
 * result is split into the three distinct reasons `foregroundFailureLine`
 * already distinguishes in its own text — a headless auto-denial that
 * starved the answer, a process that never spawned, or anything else.
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {string}
 */
function foregroundErrorCode(result) {
  if (result.status !== "failed") return result.status;
  if (result.denial) return "agy_denied";
  if (result.spawnError) return "spawn_failed";
  return "run_failed";
}

/**
 * The `error.message` for a non-completed `finishForeground` result: the
 * plugin's own one-line reason, never agy's raw stderr. A `run_failed` result
 * that carries the runtime's safe reason (`result.errorMessage`: redacted,
 * one line, bounded by `safe-reason.mjs`) uses it, for example `API error
 * (attempt 1): UNAVAILABLE (code 503): No capacity available ...`. For every
 * other result but `auth_required` this is {@link foregroundFailureLine}'s
 * text with the `antigravity:<kind> — ` prefix stripped. The stderr line
 * itself stays `failed (<status>).`, because stderr already carries the full
 * upstream text after it.
 *
 * @param {string} kind
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {string}
 */
function foregroundErrorMessage(kind, result) {
  if (result.status === "auth_required") return "Antigravity is not authenticated.";
  if (foregroundErrorCode(result) === "run_failed" && result.errorMessage) return result.errorMessage;
  const prefix = `antigravity:${kind} — `;
  const line = foregroundFailureLine(kind, result);
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/**
 * `details` for a non-completed `finishForeground` envelope: the same
 * `deniedActions` (with remedy) a completed envelope carries, plus
 * `agyConversationId` and `resumeCommand` when the run is a resumable denial
 * — the same three facts {@link resumeHintLine} already gates on, so this
 * never shows a resume command `resumeHintLine` itself would not print.
 *
 * @param {string} kind
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {object}
 */
function foregroundErrorDetails(kind, result) {
  const resumeLine = resumeHintLine(kind, result);
  return {
    ...deniedActionsDetails(result, kind),
    ...(result.agyConversationId ? { agyConversationId: result.agyConversationId } : {}),
    ...(resumeLine ? { resumeCommand: resumeLine } : {}),
  };
}

/**
 * Emit the one `--json` error envelope for a non-completed `finishForeground`
 * result (Task 3, "Senate R1", 2026-09), or nothing when `json` is false —
 * `outputCommandResult` already no-ops on an empty `rendered` string, so this
 * never prints to stdout on the markdown path, matching the pre-Task-3
 * contract for every status it now covers.
 *
 * @param {string} kind
 * @param {{ id: string }} job
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {boolean} [json]
 * @returns {void}
 */
function emitForegroundErrorEnvelope(kind, job, result, json) {
  outputCommandResult(
    createErrorEnvelope(kind, {
      status: result.status,
      jobId: job.id,
      error: {
        code: foregroundErrorCode(result),
        phase: "run",
        message: foregroundErrorMessage(kind, result),
      },
      details: foregroundErrorDetails(kind, result),
    }),
    "",
    Boolean(json),
  );
}

/**
 * `finishForeground`'s `auth_required` branch, split out to keep that
 * function under the complexity ceiling (Task 3, "Senate R1", 2026-09):
 * stderr output is byte-for-byte unchanged; the only addition is the
 * `--json` error envelope.
 *
 * @param {string} kind
 * @param {{ id: string }} job
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {boolean} [json]
 * @returns {1}
 */
function finishForegroundAuthRequired(kind, job, result, json) {
  process.stderr.write(
    `\nantigravity:${kind} — Antigravity is not authenticated.\n` +
      `Run /antigravity:setup to complete the OAuth flow, then retry.\n`,
  );
  if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
  emitForegroundErrorEnvelope(kind, job, result, json);
  return 1;
}

/**
 * `finishForeground`'s non-completed, non-`auth_required` branch (`failed`
 * including denial-starved, `cancelled`, `timeout`), split out to keep that
 * function under the complexity ceiling (Task 3, "Senate R1", 2026-09):
 * stderr output is byte-for-byte unchanged; the only addition is the
 * `--json` error envelope.
 *
 * @param {string} kind
 * @param {{ id: string }} job
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {boolean} [json]
 * @returns {1 | 2}
 */
function finishForegroundFailure(kind, job, result, json) {
  process.stderr.write(`\n${foregroundFailureLine(kind, result)}\n`);
  // redactBypassFlag runs after stripBypassAdvice: stripBypassAdvice drops
  // agy's own "Alternatively, ..." suggestion; redactBypassFlag then
  // catches the flag string wherever else it appears on this echo, such
  // as inside a plugin-authored denial label naming a model-chosen
  // `target` that IS the flag (plan 086 T5e F3). Neither call mutates
  // `result.stderr` itself, so the stored record keeps the complete text.
  const echoed = result.stderr ? redactBypassFlag(stripBypassAdvice(result.stderr)) : "";
  if (echoed) process.stderr.write(echoed);
  const resumeLine = resumeHintLine(kind, result);
  // agy's own stderr does not always end in a newline, so without this the
  // resume line lands glued to the end of the denial line and a caller
  // reading stderr line by line sees one line where there are two.
  if (resumeLine) {
    const separator = echoed && !echoed.endsWith("\n") ? "\n" : "";
    process.stderr.write(`${separator}${resumeLine}\n`);
  }
  emitForegroundErrorEnvelope(kind, job, result, json);
  return result.status === "cancelled" ? 2 : 1;
}

export function finishForeground(kind, job, result, {
  json, extraDetails = {}, extraFields = {}, beforeAnswer, resultDetails, extraStderrLines, renderedSuffix,
} = {}) {
  if (result.status === "auth_required") return finishForegroundAuthRequired(kind, job, result, json);
  if (result.status !== "completed") return finishForegroundFailure(kind, job, result, json);

  const ownDetails = { ...extraDetails, ...resultDetails?.(result) };
  reportWarnings(kind, result);
  reportDeniedActionHints(kind, result);
  reportPrintTimeoutHint(kind, result);
  reportFindingsWarning(kind, ownDetails);
  for (const line of extraStderrLines?.(result, ownDetails) ?? []) process.stderr.write(`${line}\n`);
  beforeAnswer?.();
  printMeasuredUsageTrailer(result.usage);
  const rendered = appendRenderedLines(result.stdout, renderedSuffix?.(result, ownDetails) ?? []);
  outputCommandResult(
    createJsonEnvelope(kind, {
      status: "completed",
      jobId: job.id,
      answer: result.stdout,
      ...extraFields,
      details: {
        ...ownDetails,
        ...deniedActionsDetails(result, kind),
        ...agyPrintTimeoutDetails(result),
        ...warningDetails(result),
      },
    }),
    rendered,
    Boolean(json),
  );
  return 0;
}

/**
 * Set on every child `host-bootstrap.cjs` spawns (Claude Code and the agy
 * TUI both reach every verb through it, per `commands/*.md`'s `node -e`
 * snippet) so the runtime can tell a host-driven invocation apart from a
 * human typing directly into the standalone CLI or an already-interactive
 * shell, even when both happen to inherit a real TTY on stdio (plan 086
 * T5k F2). Duplicated as a string literal in `host-bootstrap.cjs` — that
 * module is CommonJS and must stay `require()`-able synchronously from a
 * one-line snippet, the same reason it already duplicates
 * `isPluginRoot`/message wording instead of importing this ES module.
 */
export const HOST_WRAPPER_ENV = "ANTIGRAVITY_HOST_WRAPPER";

/**
 * True when a denied foreground run may ask the user what to do next on the
 * terminal itself (plan 086 T5k F2). All four conditions must hold:
 *   - the caller did not pass `--json` (a prompt on a machine-readable
 *     stream has nowhere safe to go);
 *   - this process was not spawned by a host wrapper ({@link HOST_WRAPPER_ENV});
 *   - both `stdin` and `stdout` are a real interactive terminal.
 * A background job never reaches this function at all — `startBackgroundJob`
 * and `_worker.mjs` never call `finishForeground` or anything downstream of
 * it, and the worker's own stdio is spawned as `["ignore", "ignore",
 * "ignore"]` besides — so there is no separate "is this a background job"
 * flag to check here.
 *
 * @param {{ json?: boolean, stdin?: { isTTY?: boolean }, stdout?: { isTTY?: boolean },
 *   env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean}
 */
export function canPromptOnDenial({ json, stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  if (json) return false;
  if (env[HOST_WRAPPER_ENV]) return false;
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

/**
 * Ask on the terminal whether to retry the same conversation or stop, after
 * a denied foreground run. Exactly two choices, never a third, and the
 * plugin never offers to grant a permission or write a settings file here.
 * Anything other than a case-insensitive "retry" (including EOF, a blank
 * line, or an unrecognized word) resolves "stop" — the caller asks at most
 * once, so a wrong or empty answer must fail safe, not repeat the question.
 *
 * @param {string} kind
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
 *   createInterface?: typeof createInterface }} [io]
 * @returns {Promise<"retry" | "stop">}
 */
export async function askRetryOrStop(kind, { input = process.stdin, output = process.stdout, createInterface: createIface = createInterface } = {}) {
  const rl = createIface({ input, output, terminal: false });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(
        `antigravity:${kind} — the run was denied. Retry the same conversation now, or stop? [retry/stop] `,
        resolve,
      );
    });
    return String(answer).trim().toLowerCase() === "retry" ? "retry" : "stop";
  } finally {
    rl.close();
  }
}

/**
 * True when a foreground result is a candidate for the interactive retry
 * offer: not completed, denied, and agy reported a conversation id to retry
 * against. The same three facts {@link resumeHintLine} checks, reused here
 * so the two never disagree about what counts as "a resumable denial".
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {boolean}
 */
function isRetryEligible(result) {
  return result?.status !== "completed" && Boolean(result?.denial) && Boolean(result?.agyConversationId);
}

/**
 * The foreground tail shared by `review`/`rescue`/`task`'s resumable path
 * (plan 086 T5k F2): report the run exactly as {@link finishForeground}
 * always has, then — only when the result is a resumable denial AND
 * {@link canPromptOnDenial} allows it — ask once whether to retry the same
 * conversation. Choosing "stop" (or any non-eligible/non-interactive path)
 * returns the exit code the run already had, unchanged. Choosing "retry"
 * runs `runOnce` exactly once more against the conversation id agy reported,
 * reports THAT outcome the same way, and returns its exit code instead —
 * denied again or not, this never asks a second time.
 *
 * @param {string} kind
 * @param {(retryConversationId?: string) => Promise<{ job: object, result: import('./types.mjs').RuntimeResult }>} runOnce
 *   runs one `runForegroundJob` call; called with no argument for the first
 *   attempt, and with agy's own conversation id for the retry
 * @param {{ json: boolean, extraDetails?: object, extraFields?: object, beforeAnswer?: () => void,
 *   resultDetails?: (result: import('./types.mjs').RuntimeResult) => object }} finishOptions
 *   forwarded to `finishForeground` for both the first report and the retry's
 * @param {{ canPrompt?: typeof canPromptOnDenial, ask?: typeof askRetryOrStop }} [deps]
 * @returns {Promise<number>}
 */
export async function runForegroundWithRetryPrompt(kind, runOnce, finishOptions, { canPrompt = canPromptOnDenial, ask = askRetryOrStop } = {}) {
  const first = await runOnce();
  const exitCode = finishForeground(kind, first.job, first.result, finishOptions);
  if (!isRetryEligible(first.result) || !canPrompt({ json: finishOptions.json })) return exitCode;

  const choice = await ask(kind);
  if (choice !== "retry") return exitCode;

  const retry = await runOnce(first.result.agyConversationId);
  return finishForeground(kind, retry.job, retry.result, finishOptions);
}

/**
 * `{ deniedActions: [...] }` when `result` carries any, else `{}` — the same
 * "absent key on a clean run" shape `warningDetails` uses, for the
 * `{ action, displayName, remedy }` projection under `--json`'s
 * `details.deniedActions` (item 4).
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {string} kind
 * @returns {{ deniedActions?: import('./types.mjs').DeniedActionWithRemedy[] }}
 */
function deniedActionsDetails(result, kind) {
  const list = deniedActionsWithRemedy(result.deniedActions, kind);
  return list ? { deniedActions: list } : {};
}

/**
 * `{ agyPrintTimeout: {...} }` when the run's answer was cut short by agy's
 * own print timeout ({@link runAgyPrint}, `agent-runtime.mjs#detectPrintTimeoutTruncation`),
 * else `{}` — the same "absent key on a clean run" shape `warningDetails`/
 * `deniedActionsDetails` use, for `details.agyPrintTimeout` on a completed
 * foreground envelope (plan 086 T1). `result.mjs` and `status.mjs` project
 * the same field for their own envelopes.
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {{ agyPrintTimeout?: import('./types.mjs').AgyPrintTimeout }}
 */
function agyPrintTimeoutDetails(result) {
  return result?.agyPrintTimeout ? { agyPrintTimeout: result.agyPrintTimeout } : {};
}

/**
 * Echo one warning line to stderr when a completed run's answer was cut
 * short by agy's own print timeout — printed next to the existing warning
 * and denied-action lines (item 4, plan 086 T1). A no-op on a clean run or a
 * run that failed outright (the failure line already covers that case).
 *
 * @param {string} kind
 * @param {import('./types.mjs').RuntimeResult} result
 * @returns {void}
 */
export function reportPrintTimeoutHint(kind, result) {
  const marker = result?.agyPrintTimeout;
  if (!marker) return;
  const limitNote = marker.limit ? ` (${marker.limit})` : "";
  process.stderr.write(
    `antigravity:${kind} — warning: agy's print timeout expired${limitNote} before the turn finished; the answer may be partial.\n`,
  );
}

/**
 * Resolve the absolute OS filesystem path to the background worker script
 * (scripts/commands/_worker.mjs), for spawning via
 * `node <path> <jobId> <workspaceRoot>`.
 *
 * Uses `fileURLToPath`, NOT `URL.pathname` — on Windows, `.pathname` yields
 * a POSIX-shaped path (`/A:/projects-vault/...`) that does not exist on
 * disk. `spawn` would then launch `node` against a nonexistent file; Node
 * exits `MODULE_NOT_FOUND`, but with `stdio: ['ignore','ignore','ignore']`
 * (see `startBackgroundJob` below) that failure was invisible — the job
 * never left `queued`, and `waitForJob`/`task --wait` hung until timeout
 * (or forever with `timeoutMs: 0`).
 *
 * @returns {string}
 */
export function resolveWorkerPath() {
  return fileURLToPath(new URL("../commands/_worker.mjs", import.meta.url));
}

/**
 * The `request` object `startBackgroundJob` persists on the job (and a
 * background worker later replays): the caller's own fields plus its
 * `request` fragment layered on top, plus the execution timeout budget.
 * Split out so `startBackgroundJob` itself stays under the complexity
 * ceiling.
 *
 * @param {{ prompt: string, mode: string, conversationId: string | null,
 *   addDirs: string[], extraArgs: string[], cwd: string | undefined,
 *   workspaceRoot: string, request: object | null, env: NodeJS.ProcessEnv }} args
 * @returns {import('./types.mjs').JobRequest}
 */
function buildBackgroundRequest({ prompt, mode, conversationId, addDirs, extraArgs, cwd, workspaceRoot, request, env }) {
  return {
    prompt,
    mode,
    conversationId,
    addDirs,
    extraArgs,
    cwd: cwd ?? workspaceRoot,
    ...(request ?? {}),
    timeoutMs: agyTimeoutMs(env),
  };
}

/**
 * Create the background job, claiming `requestId` first when one is given
 * (Senate R12, 2026-09). Without an id this is exactly
 * {@link createTrackedJob}. With one, the stored request gains
 * `requestId` and `requestFingerprint`, and the claim plus the job creation
 * run in one locked critical section (`state.mjs#claimRequestId`).
 *
 * @param {TrackedJobOptions & { request: import('./types.mjs').JobRequest }} jobOptions
 * @param {string | null} requestId
 * @returns {Promise<{ outcome: "created" | "deduplicated" | "conflict", jobId?: string,
 *   job: import('./types.mjs').JobIndexEntry }>}
 */
async function createBackgroundJob(jobOptions, requestId) {
  if (!requestId) return { outcome: "created", job: await createTrackedJob(jobOptions) };
  const { workspaceRoot, kind } = jobOptions;
  const fingerprint = requestFingerprint({ ...jobOptions.request, kind, cwd: workspaceRoot });
  const request = { ...jobOptions.request, requestId, requestFingerprint: fingerprint };
  return claimRequestId(workspaceRoot, requestId, fingerprint, () => createTrackedJobUnlocked({ ...jobOptions, request }));
}

/**
 * Fire-and-forget a background worker that will run the prompt with the
 * given mode. Returns the queued job index entry.
 *
 * With `requestId` (`--request-id`, Senate R12, 2026-09) an id this
 * workspace already claimed spawns nothing and returns `{ job: null, pid:
 * null, requestClaim }`, where `requestClaim` is `claimRequestId`'s
 * `deduplicated` or `conflict` outcome. No automatic retry happens on any
 * path.
 *
 * The worker script lives at scripts/commands/_worker.mjs and is invoked as
 * `node <worker.mjs> <jobId> <workspaceRoot>`.
 *
 * @param {import('./types.mjs').ProcessRequest & { workspaceRoot: string,
 *   kind: import('./types.mjs').JobKind, title?: string | null,
 *   request?: object | null, env?: NodeJS.ProcessEnv,
 *   agyVersion?: string | null, spawnWorker?: typeof spawn,
 *   persistWorkerPid?: typeof patchJob,
 *   terminateTree?: typeof terminateProcessTree, requestId?: string | null }} options
 * @returns {Promise<{ job: import('./types.mjs').JobIndexEntry | null, pid: number | null,
 *   requestClaim?: { outcome: "deduplicated" | "conflict", jobId: string,
 *   job: import('./types.mjs').JobIndexEntry } }>}
 */
export async function startBackgroundJob({
  workspaceRoot,
  kind,
  title,
  prompt,
  mode = "print",
  conversationId = null,
  addDirs = [],
  extraArgs = [],
  cwd,
  request = null,
  env = process.env,
  agyVersion = null,
  spawnWorker = spawn,
  persistWorkerPid = patchJob,
  terminateTree = terminateProcessTree,
  requestId = null,
}) {
  const claim = await createBackgroundJob({
    workspaceRoot,
    kind,
    title,
    request: buildBackgroundRequest({ prompt, mode, conversationId, addDirs, extraArgs, cwd, workspaceRoot, request, env }),
    conversationId,
    env,
    agyVersion,
  }, requestId);
  if (claim.outcome !== "created") return { job: null, pid: null, requestClaim: claim };
  return launchWorker(workspaceRoot, claim.job, { env, spawnWorker, persistWorkerPid, terminateTree });
}

/**
 * Spawn the detached worker for a freshly created job and record its PID;
 * on a launch failure, mark the job `failed` instead. Split out of
 * {@link startBackgroundJob} so that function stays under the complexity
 * ceiling.
 *
 * @param {string} workspaceRoot
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {{ env: NodeJS.ProcessEnv, spawnWorker: typeof spawn,
 *   persistWorkerPid: typeof patchJob, terminateTree: typeof terminateProcessTree }} deps
 * @returns {Promise<{ job: import('./types.mjs').JobIndexEntry, pid: number | null }>}
 */
async function launchWorker(workspaceRoot, job, { env, spawnWorker, persistWorkerPid, terminateTree }) {
  const workerPath = resolveWorkerPath();
  let child;
  let spawned = false;
  try {
    child = spawnWorker(process.execPath, [workerPath, job.id, workspaceRoot], {
      cwd: workspaceRoot,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...env, [SESSION_ID_ENV]: env[SESSION_ID_ENV] ?? "" },
    });
    await new Promise((resolve, reject) => {
      // Retain the listener after acknowledgement: late errors must stay handled.
      child.on("error", reject);
      child.once("spawn", resolve);
    });
    spawned = true;
    await persistWorkerPid(workspaceRoot, job.id, {
      pid: child.pid ?? null,
      workerPid: child.pid ?? null,
    });
    child.unref();
  } catch (error) {
    if (spawned) await terminateTree(child.pid);
    child?.unref?.();
    const failed = await patchJob(workspaceRoot, job.id, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: `Worker launch failed: ${error.message}`,
      healthStatus: "failed",
    });
    return { job: failed, pid: null };
  }
  appendJobLog(workspaceRoot, job.id, `[job] dispatched worker pid=${child.pid}`);
  return { job, pid: child.pid ?? null };
}

/**
 * Block in the current process until a job reaches a terminal state.
 *
 * Polls at `pollMs` (default 1000ms). Returns the latest job record. The
 * default 30-minute deadline prevents an unbounded wait; pass 0 explicitly
 * only when another supervisor owns the deadline.
 *
 * @param {string} workspaceRoot the resolved workspace root
 * @param {string} jobId
 * @param {{ pollMs?: number, timeoutMs?: number, isProcessAlive?: typeof processIsAlive,
 *   now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<import('./types.mjs').JobRecord | null>}
 */
/**
 * @param {import('./types.mjs').JobRecord | null} job
 * @param {number} workerPid
 * @param {typeof processIsAlive} isProcessAlive
 * @returns {boolean} true when the job looks active but its worker PID is gone
 */
function isWorkerVanished(job, workerPid, isProcessAlive) {
  return Boolean(
    job &&
    (job.status === "running" || job.status === "queued") &&
    Number.isInteger(workerPid) && workerPid > 0 &&
    !isProcessAlive(workerPid),
  );
}

/**
 * Persist and log the terminal state for a job whose worker vanished
 * without recording a result. Terminates the recorded `agyPid` FIRST, before
 * the job flips to a terminal (non-cancelable) status: on POSIX agy is
 * spawned detached in its own process group, so the worker dying does not
 * take it with it, and `resolveCancelableJob` (job-control.mjs) only matches
 * `running`/`queued` jobs — once this function's own `patchJob` call below
 * lands, a later `/antigravity:cancel` can no longer find the job at all, so
 * a live `agyPid` would be orphaned with no reachable way to stop it (plan
 * 086 T5e F4). Termination failures are swallowed (`.catch(() => {})`): a
 * pid that cannot be killed here is no worse than the pre-fix behaviour, and
 * must never block persisting the terminal state.
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {number} workerPid
 * @param {number | null | undefined} agyPid
 * @param {typeof terminateProcessTree} terminateTree
 * @returns {Promise<import('./types.mjs').JobRecord>}
 */
async function markWorkerVanished(workspaceRoot, jobId, workerPid, agyPid, terminateTree) {
  if (Number.isInteger(agyPid) && agyPid > 0) {
    await terminateTree(agyPid).catch(() => {});
  }
  const failed = await patchJob(workspaceRoot, jobId, {
    status: "failed",
    phase: "worker_missing",
    completedAt: new Date().toISOString(),
    healthStatus: "worker_missing",
    healthMessage: `Worker process ${workerPid} vanished before recording a terminal result.`,
    recommendedAction: "Inspect the job log, then retry the task.",
    errorMessage: `Background worker process ${workerPid} is no longer running.`,
  });
  appendJobLog(workspaceRoot, jobId, `[wait] worker pid=${workerPid} vanished; marked failed`);
  return failed;
}

export async function waitForJob(
  workspaceRoot,
  jobId,
  {
    pollMs = 1000,
    timeoutMs = 30 * 60 * 1000,
    isProcessAlive = processIsAlive,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    terminateTree = terminateProcessTree,
  } = {},
) {
  const deadline = timeoutMs > 0 ? now() + timeoutMs : null;
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  while (true) {
    const job = readJobFile(workspaceRoot, jobId);
    if (!job || TERMINAL.has(job.status)) return job;
    const workerPid = Number(job?.workerPid ?? job?.pid);
    if (isWorkerVanished(job, workerPid, isProcessAlive)) {
      return markWorkerVanished(workspaceRoot, jobId, workerPid, Number(job?.agyPid), terminateTree);
    }
    if (deadline !== null && now() >= deadline) return job;
    await sleep(pollMs);
  }
}

/**
 * `answerBytes` (UTF-8 byte length) and `answerLines` (line count, a
 * trailing newline does not add a line) for a stored answer text — computed
 * at job finish from the same `result.stdout` `buildStoredResult` projects,
 * for both the foreground path (below) and the background worker
 * (`_worker.mjs`). `null` for both fields when there is no answer text
 * (076-T7 R1).
 *
 * @param {unknown} answer
 * @returns {{ answerBytes: number | null, answerLines: number | null }}
 */
export function deriveAnswerSize(answer) {
  if (typeof answer !== "string") return { answerBytes: null, answerLines: null };
  if (answer.length === 0) return { answerBytes: 0, answerLines: 0 };
  const withoutTrailingNewline = answer.endsWith("\n") ? answer.slice(0, -1) : answer;
  return {
    answerBytes: Buffer.byteLength(answer, "utf8"),
    answerLines: withoutTrailingNewline.split("\n").length,
  };
}

/**
 * First non-blank line of a run's stdout, truncated to 120 chars — the one
 * summary derivation used by both the foreground path and the background
 * worker (item 16).
 *
 * @param {{ stdout?: string | null }} result
 * @returns {string | null}
 */
export function deriveSummary(result) {
  if (!result?.stdout) return null;
  const firstLine = result.stdout.split("\n").map((s) => s.trim()).find(Boolean);
  if (!firstLine) return null;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

/**
 * The `errorMessage` a terminal job record stores (foreground and worker
 * share it). The runtime's own reason wins; for a failed job without one the
 * fallback is agy's stderr put through {@link safeFailureReason}, never the
 * raw text, because the `--show-result` envelope, `status` and `result`
 * render this field as it is. `null` when no safe reason can be made, so
 * readers fall back to `healthMessage` or their generic text. The unredacted
 * stderr stays on `result.stderr` only.
 *
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {boolean} failed whether the job ended as `failed`
 * @returns {string | null}
 */
export function storedErrorMessage(result, failed) {
  return result.errorMessage ?? (failed ? safeFailureReason(result.stderr) : null);
}

/** Re-export so command modules can pull everything from one place. */
export { runAgyPrint, resolveAgyBin };
