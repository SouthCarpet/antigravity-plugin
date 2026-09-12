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
import { spawn } from "./process-adapter.mjs";
import {
  appendJobLog,
  resolveJobLogFile,
  patchJobState,
  readJobFile,
} from "./state.mjs";
import { SESSION_ID_ENV } from "./job-control.mjs";
import { isProcessAlive as processIsAlive, terminateProcessTree } from "./process.mjs";
import { createJobActivityRecorder } from "./job-activity.mjs";
import {
  createJsonEnvelope,
  outputCommandResult,
  reportWarnings,
  warningDetails,
  formatDeniedActionLabel,
  stripBypassAdvice,
  redactBypassFlag,
} from "./render.mjs";

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
 * for the current CLI session (low|medium|high)"). `review` and `vision`
 * never expose `--effort`; only `task` and `rescue` forward it. */
export const AGY_EFFORTS = ["low", "medium", "high"];

/**
 * The `--effort` value `task` and `rescue` apply when the caller passes
 * none (plan 086 T2, disclosed 1.x default). Measured basis: a run without
 * `--effort` sends no effort field at all, so the value agy uses comes from
 * whatever that machine has saved — a delegated run is not reproducible
 * across machines without a plugin default. `review` and `vision` do not
 * read this constant: neither exposes `--effort`, so neither gets a
 * default.
 */
export const DEFAULT_AGY_EFFORT = "medium";

/**
 * The `--effort` value that means "send no `--effort` flag at all; let agy
 * use whatever default the user configured on that machine" (plan 086 T5i).
 * It is the fourth accepted `--effort` value on `task` and `rescue`, and the
 * caller's way to reach the pre-1.4.0 behaviour `DEFAULT_AGY_EFFORT` replaced.
 */
export const AGY_DEFAULT_EFFORT = "agy-default";

/**
 * The four values `--effort` accepts on `task` and `rescue`: agy's own three
 * ({@link AGY_EFFORTS}) plus the sentinel above. `review` and `vision` do not
 * use this; neither exposes `--effort` at all.
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
 * record or starts anything. Returns `null` when agy can be spawned, else
 * the one stderr line the verb prints before it exits 1. `setup` keeps its
 * own wording and exit 2; this is for the four verbs that run agy.
 *
 * @param {string} kind verb name (`review`, `rescue`, `task`, `vision`)
 * @param {{ bin?: string, probe?: typeof probeAgy }} [opts]
 * @returns {Promise<string | null>}
 */
export async function agyUnavailableLine(kind, { bin = resolveAgyBin(), probe = probeAgy } = {}) {
  const result = await probe({ bin });
  if (result.ok) return null;
  return `antigravity:${kind} — \`agy\` is not on PATH (${result.reason}). Run /antigravity:setup.`;
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
 * @param {string} kind verb name
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {{ json?: boolean }} options
 * @returns {number | null} an exit code when the job failed to start, else
 *   null so the caller continues (e.g. to an optional `--wait`)
 */
export function reportQueuedJob(kind, job, options) {
  if (job.status === "failed") {
    process.stderr.write(`${foregroundFailureLine(kind, { spawnError: job.errorMessage })}\n`);
    return 1;
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
 * Await a background job's terminal state, print the wait-timeout line (if
 * any), and map the outcome to an exit code. The one background-wait tail
 * `rescue.mjs` and `review.mjs` each hand-wrote (item 19).
 *
 * @param {string} kind verb name
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {typeof waitForJob} wait
 * @returns {Promise<number>}
 */
export async function waitAndExit(kind, workspaceRoot, jobId, wait) {
  const final = await wait(workspaceRoot, jobId);
  const line = waitOutcomeLine(kind, final);
  if (line) process.stderr.write(`${line}\n`);
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
      };
  }
}

/**
 * Create a tracked job record on disk.
 *
 * Returns the job index entry. The detailed payload (request, result,
 * stdout) lives in the per-job file written via `writeJobFile`.
 *
 * @param {{ workspaceRoot: string, kind: import('./types.mjs').JobKind,
 *   title?: string | null, request?: import('./types.mjs').JobRequest | null,
 *   conversationId?: string | null, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<import('./types.mjs').JobIndexEntry>}
 */
export async function createTrackedJob({
  workspaceRoot,
  kind,
  title,
  request = null,
  conversationId = null,
  env = process.env,
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
  };
  await patchJob(workspaceRoot, id, {
    ...job,
    request,
    result: null,
  });
  appendJobLog(workspaceRoot, id, `[job] created kind=${kind}`);
  return job;
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
 *   env?: NodeJS.ProcessEnv }} options
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
  cwd,
  request = null,
  env = process.env,
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
    errorMessage: result.errorMessage ?? (result.status === "failed" ? trim(result.stderr) : null),
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
  };
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
 * envelope is built, for `vision`'s measured-usage trailer print, which no
 * other verb has.
 *
 * @param {string} kind verb name (`review`, `rescue`, `task`, `vision`)
 * @param {{ id: string }} job
 * @param {import('./types.mjs').RuntimeResult} result
 * @param {{ json: boolean, extraDetails?: object, extraFields?: object, beforeAnswer?: () => void }} [options]
 * @returns {number} the verb's exit code
 */
export function finishForeground(kind, job, result, { json, extraDetails = {}, extraFields = {}, beforeAnswer } = {}) {
  if (result.status === "auth_required") {
    process.stderr.write(
      `\nantigravity:${kind} — Antigravity is not authenticated.\n` +
        `Run /antigravity:setup to complete the OAuth flow, then retry.\n`,
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
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
    return result.status === "cancelled" ? 2 : 1;
  }

  reportWarnings(kind, result);
  reportDeniedActionHints(kind, result);
  reportPrintTimeoutHint(kind, result);
  beforeAnswer?.();
  outputCommandResult(
    createJsonEnvelope(kind, {
      status: "completed",
      jobId: job.id,
      answer: result.stdout,
      ...extraFields,
      details: {
        ...extraDetails,
        ...deniedActionsDetails(result, kind),
        ...agyPrintTimeoutDetails(result),
        ...warningDetails(result),
      },
    }),
    result.stdout,
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
 * @param {{ json: boolean, extraDetails?: object, extraFields?: object, beforeAnswer?: () => void }} finishOptions
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
 * Fire-and-forget a background worker that will run the prompt with the
 * given mode. Returns the queued job index entry.
 *
 * The worker script lives at scripts/commands/_worker.mjs and is invoked as
 * `node <worker.mjs> <jobId> <workspaceRoot>`.
 *
 * @param {import('./types.mjs').ProcessRequest & { workspaceRoot: string,
 *   kind: import('./types.mjs').JobKind, title?: string | null,
 *   request?: object | null, env?: NodeJS.ProcessEnv,
 *   spawnWorker?: typeof spawn, persistWorkerPid?: typeof patchJob,
 *   terminateTree?: typeof terminateProcessTree }} options
 * @returns {Promise<{ job: import('./types.mjs').JobIndexEntry, pid: number | null }>}
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
  spawnWorker = spawn,
  persistWorkerPid = patchJob,
  terminateTree = terminateProcessTree,
}) {
  const job = await createTrackedJob({
    workspaceRoot,
    kind,
    title,
    request: {
      prompt,
      mode,
      conversationId,
      addDirs,
      extraArgs,
      cwd: cwd ?? workspaceRoot,
      ...(request ?? {}),
      timeoutMs: agyTimeoutMs(env),
    },
    conversationId,
    env,
  });

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
 * The one trimming helper used by both the foreground path and the
 * background worker to turn a possibly-blank stderr into an
 * `errorMessage` (item 16).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function trim(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Re-export so command modules can pull everything from one place. */
export { runAgyPrint, resolveAgyBin };
