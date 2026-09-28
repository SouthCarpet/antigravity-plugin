/**
 * Output rendering — formats reviews, status, results, and reports as markdown.
 */

import { sanitizeDisplayPath } from "./fs.mjs";

export const JSON_ENVELOPE_VERSION = 1;

/**
 * Build the stable outer envelope used by every command that supports
 * --json. Command-specific fields belong in `details`; model output belongs
 * in the deliberately opaque `answer` string.
 *
 * @param {string} command
 * @param {{ status: string, jobId?: string|null, answer?: string|null,
 *   details?: object, [key: string]: any }} fields
 * @returns {import('./types.mjs').JsonEnvelopeV1}
 */
export function createJsonEnvelope(command, fields = {}) {
  const {
    status,
    jobId = null,
    answer = null,
    details = {},
    ...stableCommandFields
  } = fields;
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("JSON envelope command must be a non-empty string");
  }
  if (typeof status !== "string" || status.length === 0) {
    throw new TypeError("JSON envelope status must be a non-empty string");
  }
  if (jobId !== null && typeof jobId !== "string") {
    throw new TypeError("JSON envelope jobId must be a string or null");
  }
  if (answer !== null && typeof answer !== "string") {
    throw new TypeError("JSON envelope answer must be a string or null");
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new TypeError("JSON envelope details must be an object");
  }
  if (Object.hasOwn(stableCommandFields, "schemaVersion") ||
      Object.hasOwn(stableCommandFields, "command")) {
    throw new TypeError("JSON envelope reserved fields cannot be overridden");
  }
  return {
    schemaVersion: JSON_ENVELOPE_VERSION,
    command,
    status,
    jobId,
    answer,
    ...stableCommandFields,
    details,
  };
}

/**
 * Every `details.error.code` value a Task 3 ("Senate R1", 2026-09) envelope
 * can carry, frozen so docs and tests enumerate the same list this module
 * builds from — never a second, hand-copied list. A later task
 * (`--require-complete`, `--show-result`, `--request-id`) adds its own codes
 * only through {@link createErrorEnvelope}, and should extend this array in
 * the same change.
 */
export const ERROR_CODES = Object.freeze([
  // no_agy, phase probe
  "agy_not_found",
  // failed, phase run
  "worker_start_failed",
  "spawn_failed",
  "agy_denied",
  "run_failed",
  // cancelled | auth_required | timeout, phase run (code matches status)
  "cancelled",
  "auth_required",
  "timeout",
  // invalid_input, phase collect (review only)
  "invalid_scope",
  "unknown_base_ref",
  "review_collection_failed",
  // invalid_input, phase collect (review only): --require-complete refused
  // to send an input with a skip or a truncation (Task 5, "Senate R5", 2026-09)
  "input_incomplete",
  // invalid_input, phase validate
  "missing_task_text",
  "invalid_focus",
  "missing_image_path",
  "image_not_found",
  "unsupported_image_extension",
  "image_too_large",
  // invalid_input, phase validate (task/rescue background): --request-id
  // already claimed by a different request (Senate R12, 2026-09)
  "request_id_conflict",
  // invalid_input, phase validate (task --prompt-file / stdin, Senate R13,
  // 2026-09): the named file or stdin content is over the byte cap, the
  // named file could not be found or read, or the content is empty or
  // whitespace-only
  "prompt_file_too_large",
  "prompt_file_unreadable",
  "prompt_file_empty",
  // state_error, phase state (status/result/cancel)
  "job_not_found",
  "job_not_ready",
  "invalid_job_record",
  "state_locked",
  // result <id> on a stored failed job (status stays "failed")
  "job_failed",
  // --show-result after a background --wait (Task 7, "Senate R9", 2026-09):
  // the awaited job settled cancelled, or the wait itself timed out while
  // the job was still queued/running (status matches, phase "wait")
  "job_cancelled",
  "wait_timeout",
]);

/**
 * Build the one failure envelope every expected-failure path emits under
 * `--json` (Task 3, "Senate R1", 2026-09): `answer` is always `null`, and
 * `error` (`{ code, phase, message }`) is always present under `details`.
 * `error.message` never carries a token, an OAuth URL, or the full upstream
 * stderr — callers pass the plugin's own one-line reason.
 *
 * Built on {@link createJsonEnvelope}, so it inherits the same field
 * validation; a later task adds a new `status`/`error.code` pairing only by
 * calling this helper, never by hand-assembling the shape again.
 *
 * @param {string} command
 * @param {{ status: string, jobId?: string|null,
 *   error: { code: string, phase: string, message: string },
 *   details?: object }} fields
 * @returns {import('./types.mjs').JsonEnvelopeV1}
 */
export function createErrorEnvelope(command, { status, jobId = null, error, details = {} } = {}) {
  if (!error || typeof error !== "object" ||
      typeof error.code !== "string" || !error.code ||
      typeof error.phase !== "string" || !error.phase ||
      typeof error.message !== "string" || !error.message) {
    throw new TypeError("error envelope requires error.code, error.phase, and error.message");
  }
  return createJsonEnvelope(command, {
    status,
    jobId,
    answer: null,
    details: { ...details, error },
  });
}

/**
 * `details` fragment for runtime warnings (headless auto-denials that did
 * not starve the answer, see agent-runtime.mjs). Present only when there is
 * at least one, so a clean envelope is unchanged.
 *
 * @param {{ warnings?: string[] }} result
 * @returns {{ warnings?: string[] }}
 */
export function warningDetails(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  return warnings.length ? { warnings } : {};
}

/**
 * agy's headless-denial sentinel repeats its own bypass advice on the same
 * line as the allow-rule hint (measured 1.2.1,
 * `t0-plugin-task-denied-url.txt`): "... Alternatively, re-run with
 * `--dangerously-skip-permissions` to auto-approve all tools." Relaying that
 * sentence on the plugin's own stderr contradicts `SECURITY.md` (the plugin
 * never suggests bypassing headless permission checks), so this drops just
 * that sentence from a line that contains the flag and keeps the rest of the
 * line untouched — anchored on the flag name and the `Alternatively,`
 * lead-in, the two parts of the sentence most likely to stay stable if agy
 * rewords the rest (plan 086 T3 item 4).
 *
 * This only changes what reaches the console (`reportWarnings` below,
 * `job-helpers.mjs#finishForeground`'s failure echo): the stored result and
 * `result --json` keep the complete upstream line unmodified.
 *
 * @param {string} stderr
 * @returns {string}
 */
export function stripBypassAdvice(stderr) {
  if (typeof stderr !== "string" || !stderr.length) return stderr;
  return stderr
    .split("\n")
    .map((line) => (line.includes("--dangerously-skip-permissions")
      ? line.replace(/\s*Alternatively,[^\n]*$/, "")
      : line))
    .join("\n");
}

/** The one string SECURITY.md promises the plugin's own stderr never prints. */
const BYPASS_FLAG = "--dangerously-skip-permissions";

/**
 * Replace every literal occurrence of {@link BYPASS_FLAG} in `text` with a
 * fixed placeholder (plan 086 T5e F3): unlike {@link stripBypassAdvice}
 * (which only trims agy's own "Alternatively, ..." suggestion sentence),
 * this strips the flag itself wherever it appears — including inside
 * model-chosen `target` text on a plugin-authored denial label. A denied
 * action's `target` is the tool parameter the model itself supplied, so a
 * target that IS this flag would otherwise reach the plugin's own stderr
 * echo verbatim (`job-helpers.mjs#reportDeniedActionHints`,
 * `#applyDenialHint`) even without agy's own advisory sentence attached.
 * The stored result and `result --json` are unaffected: they render the
 * untouched label via {@link formatDeniedActionLabel}.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactBypassFlag(text) {
  return typeof text === "string" ? text.replaceAll(BYPASS_FLAG, "[flag redacted]") : text;
}

/**
 * Echo runtime warnings to stderr on a completed run. The verbs only print
 * `result.stderr` on failure, so without this a benign denial would reach
 * the stored job and `--json` but never the terminal. Each line is printed
 * through {@link stripBypassAdvice} (plan 086 T3 item 4); the stored
 * `result.warnings` array itself (and therefore `--json`'s
 * `details.warnings`) is never mutated.
 *
 * @param {string} command
 * @param {{ warnings?: string[] }} result
 * @returns {void}
 */
export function reportWarnings(command, result) {
  for (const warning of warningDetails(result).warnings ?? []) {
    process.stderr.write(`antigravity:${command} — warning: ${stripBypassAdvice(warning)}\n`);
  }
}

/**
 * Sanitize a job summary for embedding in a markdown table cell (F5/item
 * 13c): a raw `|` would split the cell, and a raw CR/LF would break the row
 * across lines. A trailing `\` before a raw `|` must be escaped first, or
 * markdown reads `\|` as an escaped backslash followed by a live pipe and
 * still splits the cell. This runs only where a table row is actually
 * built — the stored/enriched job field, and therefore `--json`, keeps the
 * raw summary.
 *
 * @param {unknown} value
 * @returns {string}
 */
function summaryForTableCell(value) {
  if (typeof value !== "string") return "-";
  const collapsed = value.replace(/[\r\n]+/g, " ").trim();
  if (!collapsed) return "-";
  const escaped = collapsed.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return escaped.length > 120 ? `${escaped.slice(0, 117)}...` : escaped;
}

/**
 * `<bytes>B/<lines>L`, or `-` when either field is missing (running jobs and
 * legacy records) — 076-T7 R1: `answerBytes`/`answerLines` shown in the
 * `status` table.
 *
 * @param {{ answerBytes?: number | null, answerLines?: number | null }} job
 * @returns {string}
 */
function formatAnswerSize(job) {
  if (typeof job.answerBytes !== "number" || typeof job.answerLines !== "number") return "-";
  return `${job.answerBytes}B/${job.answerLines}L`;
}

/**
 * A short marker for the status table (plan 085 T2 item 4): the denied-
 * action count, or `-` when none/absent (legacy records, a clean run).
 * Always a plain non-negative integer or a literal dash, so no table-cell
 * escaping applies here (contrast `summaryForTableCell`).
 *
 * @param {{ deniedActionsCount?: number, deniedActions?: unknown[] | null }} job
 * @returns {string}
 */
function formatDeniedMarker(job) {
  const count = typeof job.deniedActionsCount === "number"
    ? job.deniedActionsCount
    : Array.isArray(job.deniedActions) ? job.deniedActions.length : 0;
  return count > 0 ? String(count) : "-";
}

/**
 * A short marker for the status table (plan 086 T1): `partial` when agy's
 * own print timeout truncated the job's answer, or `-` when absent (legacy
 * records, a clean run). Plain text, no table-cell escaping needed.
 *
 * @param {{ agyPrintTimeout?: import('./types.mjs').AgyPrintTimeout | null }} job
 * @returns {string}
 */
function formatPrintTimeoutMarker(job) {
  return job.agyPrintTimeout ? "partial" : "-";
}

/**
 * True when at least one listed job's provenance names a model or an effort
 * (plan 103 T2, "Senate R11", 2026-09) — the gate for the Recent Jobs
 * table's optional `Model`/`Effort` columns, so a fleet of `review`-only or
 * legacy jobs (which never carry either) leaves the table unchanged.
 *
 * @param {import('./types.mjs').JobIndexEntry[]} jobs
 * @returns {boolean}
 */
function recentJobsShowModelEffort(jobs) {
  return jobs.some((job) => job.provenance?.model || job.provenance?.effort);
}

/**
 * The Recent Jobs table header/divider row, with or without the optional
 * `Model`/`Effort` columns.
 *
 * @param {boolean} showModelEffort
 * @returns {{ header: string, divider: string }}
 */
function recentJobsTableFraming(showModelEffort) {
  if (!showModelEffort) {
    return {
      header: "| Job ID | Kind | Status | Duration | Size | Summary | Follow-up | Denied | Partial |",
      divider: "|--------|------|--------|----------|------|---------|-----------|--------|---------|",
    };
  }
  return {
    header: "| Job ID | Kind | Status | Duration | Size | Model | Effort | Summary | Follow-up | Denied | Partial |",
    divider: "|--------|------|--------|----------|------|-------|--------|---------|-----------|--------|---------|",
  };
}

/**
 * The ` <model> | <effort> |` cell fragment for one Recent Jobs row, or `""`
 * when the table's optional columns are not shown.
 *
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {boolean} showModelEffort
 * @returns {string}
 */
function formatModelEffortCells(job, showModelEffort) {
  if (!showModelEffort) return "";
  return ` ${job.provenance?.model ?? "-"} | ${job.provenance?.effort ?? "-"} |`;
}

/**
 * One note line when agy's own print timeout truncated the answer (plan 086
 * T1): used by the single-job `status` view and by `result`. Empty when
 * there is nothing to show.
 *
 * @param {import('./types.mjs').AgyPrintTimeout | null | undefined} marker
 * @returns {string[]}
 */
export function renderPrintTimeoutNote(marker) {
  if (!marker) return [];
  const limitNote = marker.limit ? ` (${marker.limit})` : "";
  return ["", `Note: the answer is partial. agy's print timeout expired${limitNote} before the run finished.`];
}

/**
 * The one-line label naming a denied action, shared by the markdown "Denied
 * Actions" list and the stderr denial hint (plan 086 T3 item 2): `action`,
 * optionally `(displayName)`, optionally ` for "target"` when the target is
 * known. `target` is untrusted model-chosen tool-parameter text — this only
 * wraps the already-sanitized/capped string (`agent-runtime.mjs`) in quotes
 * for display; it never assembles a `permissions.allow` line or a wildcard
 * (item 3).
 *
 * @param {{ action: string, displayName?: string | null, target?: string | null }} entry
 * @returns {string}
 */
export function formatDeniedActionLabel({ action, displayName, target }) {
  const base = displayName ? `${action} (${displayName})` : action;
  return target ? `${base} for "${target}"` : base;
}

/**
 * Markdown lines for a denied-actions list already carrying `remedy`
 * (`job-helpers.mjs#deniedActionsWithRemedy`): one line per action under a
 * "## Denied Actions" heading, used by the single-job status view and by
 * `result` (plan 085 T2 item 4; target added plan 086 T3 item 2). Empty when
 * there is nothing to show.
 *
 * @param {import('./types.mjs').DeniedActionWithRemedy[] | null | undefined} list
 * @returns {string[]}
 */
export function renderDeniedActionLines(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const lines = ["", "## Denied Actions", ""];
  for (const entry of list) {
    lines.push(`- **${formatDeniedActionLabel(entry)}**: ${entry.remedy}`);
  }
  return lines;
}

/**
 * Markdown lines for a job's `provenance` record (plan 103 T2, "Senate R11",
 * 2026-09): one "- **Label:** value" line per non-null field, under a
 * "## Provenance" heading, shared by the single-job status view and by
 * `result` (appended after the answer, never folded into it). Empty when
 * there is nothing to show — a legacy record with no `provenance` field, or
 * `null`.
 *
 * `inputHash` (Task 5, "Senate R5", 2026-09) is a separate parameter, not a
 * `provenance` field: it lives on the job's `request` (`review-input.mjs`'s
 * `buildReviewInput`), and `provenance` itself is deliberately never
 * extended with it — this only adds one more line to the same section.
 *
 * @param {import('./types.mjs').JobProvenance | null | undefined} provenance
 * @param {string | null | undefined} [inputHash] `request.inputHash`, when the job carries one
 * @returns {string[]}
 */
export function renderProvenanceLines(provenance, inputHash = null) {
  const fields = [
    ["Plugin version", provenance?.pluginVersion],
    ["agy version", provenance?.agyVersion],
    ["Model", provenance?.model],
    ["Effort", provenance?.effort],
    ["Mode", provenance?.mode],
    ["Add-dir count", provenance?.addDirCount],
    ["Requested at", provenance?.requestedAt],
    ["Input hash", inputHash],
  ];
  const shown = fields.filter(([, value]) => value !== null && value !== undefined);
  if (shown.length === 0) return [];
  const lines = ["", "## Provenance", ""];
  for (const [label, value] of shown) {
    lines.push(`- **${label}:** ${value}`);
  }
  return lines;
}

/**
 * Markdown for `review --preview` (Task 5, "Senate R5", 2026-09): the exact
 * included/skipped lists, counts, truncation state and hash
 * `buildReviewInput` (`review-input.mjs`) already computed, before any agy
 * call. The one place this text is built, so the markdown and the `--json`
 * `details` block can never drift onto two different word choices for the
 * same underlying object. Paths run through {@link sanitizeDisplayPath}
 * (matching `buildWorkingTreeSummary`'s own file-list lines, git.mjs):
 * an untracked or diffed file name is repository content, not plugin text.
 *
 * @param {import('./types.mjs').ReviewInput} input return value of
 *   `buildReviewInput`
 * @returns {string}
 */
export function renderReviewPreview(input) {
  const scopeLine = input.base ? `${input.scope} vs ${input.base}` : input.scope;
  const lines = [`antigravity:review — preview (scope: ${scopeLine})`, "", "## Included", ""];
  if (input.included.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of input.included) {
      const size = entry.bytes === null ? "" : ` (${entry.bytes} bytes)`;
      lines.push(`- ${entry.kind} ${sanitizeDisplayPath(entry.path)}${size}`);
    }
  }
  lines.push("", "## Skipped", "");
  if (input.skipped.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of input.skipped) {
      lines.push(`- ${sanitizeDisplayPath(entry.path)} (${entry.reason})`);
    }
  }
  lines.push(
    "",
    "## Truncation",
    "",
    input.truncated.diff
      ? `Diff truncated: yes (${input.truncated.droppedBytes} bytes dropped)`
      : "Diff truncated: no",
    "",
    "## Counts",
    "",
    `- Included files: ${input.counts.includedFiles}`,
    `- Skipped files: ${input.counts.skippedFiles}`,
    `- Diff bytes: ${input.counts.diffBytes}`,
    `- Untracked bytes: ${input.counts.untrackedBytes}`,
    "",
    "## Input hash",
    "",
    input.inputHash,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Render a status snapshot as markdown.
 *
 * @param {{ workspaceRoot: string, config: object,
 *   running: import('./types.mjs').JobRecord[], latestFinished: import('./types.mjs').JobIndexEntry | null,
 *   recent: import('./types.mjs').JobIndexEntry[], needsReview: boolean }} snapshot
 * @returns {string}
 */
export function renderStatusSnapshot(snapshot) {
  const lines = [];
  lines.push("# Antigravity Status");
  lines.push("");

  // Review gate status.
  const gateStatus = snapshot.needsReview ? "enabled" : "disabled";
  lines.push(`Review gate: ${gateStatus}`);
  lines.push("");

  // Running jobs.
  if (snapshot.running.length > 0) {
    lines.push("## Active Jobs");
    lines.push("");
    lines.push("| Job ID | Kind | Status | Phase | Health | Last Progress | Elapsed | Summary | Denied | Partial |");
    lines.push("|--------|------|--------|-------|--------|---------------|---------|---------|--------|---------|");
    for (const job of snapshot.running) {
      const elapsed = computeElapsedDisplay(job);
      lines.push(
        `| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${job.phase ?? "-"} | ${job.healthStatus ?? "-"} | ${job.lastProgressAt ?? "-"} | ${elapsed} | ${summaryForTableCell(job.summary)} | ${formatDeniedMarker(job)} | ${formatPrintTimeoutMarker(job)} |`
      );
    }
    lines.push("");
  }

  // Recent completed jobs.
  if (snapshot.recent.length > 0) {
    lines.push("## Recent Jobs");
    lines.push("");
    const showModelEffort = recentJobsShowModelEffort(snapshot.recent);
    const { header, divider } = recentJobsTableFraming(showModelEffort);
    lines.push(header);
    lines.push(divider);
    for (const job of snapshot.recent) {
      const duration = computeElapsedDisplay(job);
      const followUp = job.status === "completed" ? `/antigravity:result ${job.id}` : "-";
      lines.push(`| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${duration} | ${formatAnswerSize(job)} |${formatModelEffortCells(job, showModelEffort)} ${summaryForTableCell(job.summary)} | ${followUp} | ${formatDeniedMarker(job)} | ${formatPrintTimeoutMarker(job)} |`);
    }
    lines.push("");
  }

  if (snapshot.running.length === 0 && snapshot.recent.length === 0) {
    lines.push("No antigravity jobs found for this session.");
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * @param {import('./types.mjs').JobRecord} job
 * @returns {string[]}
 */
function renderJobHeaderLines(job) {
  const lines = [
    `# Antigravity Job: ${job.id}`,
    "",
    `- **Kind:** ${job.kind ?? "unknown"}`,
    `- **Status:** ${job.status}`,
    `- **Phase:** ${job.phase ?? "-"}`,
    `- **Title:** ${job.title ?? "-"}`,
  ];
  if (job.summary) lines.push(`- **Summary:** ${job.summary}`);
  if (typeof job.answerBytes === "number" && typeof job.answerLines === "number") {
    lines.push(`- **Answer size:** ${formatAnswerSize(job)}`);
  }
  return lines;
}

/**
 * @param {import('./types.mjs').JobRecord} job
 * @returns {string[]}
 */
function renderJobHealthLines(job) {
  return [
    "",
    "## Health",
    "",
    `- **Health:** ${job.healthStatus ?? "-"}`,
    `- **Diagnostic:** ${job.healthMessage ?? "-"}`,
    `- **Recommended Action:** ${job.recommendedAction ?? "-"}`,
  ];
}

/**
 * @param {import('./types.mjs').JobRecord} job
 * @returns {string[]}
 */
function renderJobRuntimeLines(job) {
  return [
    "",
    "## Runtime",
    "",
    `- **Elapsed:** ${job.elapsed ?? "-"}`,
    `- **PID:** ${job.pid ?? "-"}`,
    `- **Created:** ${job.createdAt ?? "-"}`,
    `- **Started:** ${job.startedAt ?? "-"}`,
    `- **Updated:** ${job.updatedAt ?? "-"}`,
    `- **Completed:** ${job.completedAt ?? "-"}`,
    `- **Last Heartbeat:** ${job.lastHeartbeatAt ?? "-"}`,
    `- **Last Progress:** ${job.lastProgressAt ?? "-"}`,
    `- **Last Model Output:** ${job.lastModelOutputAt ?? "-"}`,
    `- **Last Diagnostic:** ${job.lastDiagnosticAt ?? "-"}`,
  ];
}

/**
 * @param {import('./types.mjs').JobRecord} job
 * @returns {string[]} empty when the job has no error message
 */
function renderJobErrorLines(job) {
  if (!job.errorMessage) return [];
  return ["", "## Error", "", job.errorMessage];
}

/**
 * @param {import('./types.mjs').JobRecord} job
 * @returns {string[]} empty when the job has no recent progress lines
 */
function renderJobRecentProgressLines(job) {
  if (!job.recentProgress || job.recentProgress.length === 0) return [];
  return ["", "## Recent Progress", "", ...job.recentProgress];
}

/**
 * @param {{ workspaceRoot: string, job: import('./types.mjs').JobRecord } | import('./types.mjs').JobRecord} snapshotOrJob
 *   Either a { job } wrapper (legacy) or a bare job object.
 * @returns {boolean}
 */
function isSnapshotWrapper(snapshotOrJob) {
  return Boolean(
    snapshotOrJob &&
    typeof snapshotOrJob === "object" &&
    Object.prototype.hasOwnProperty.call(snapshotOrJob, "workspaceRoot") &&
    Object.prototype.hasOwnProperty.call(snapshotOrJob, "job"),
  );
}

/**
 * Render a single job's detailed status.
 *
 * @param {{ workspaceRoot: string, job: import('./types.mjs').JobRecord } | import('./types.mjs').JobRecord} snapshotOrJob
 *   Either a { job } wrapper (legacy) or a bare job object.
 * @param {{ now?: number }} [_options] unused; kept for call-site compatibility
 * @returns {string}
 */
export function renderSingleJobStatus(snapshotOrJob, _options = {}) {
  const job = isSnapshotWrapper(snapshotOrJob) ? snapshotOrJob.job : snapshotOrJob;
  const lines = [
    ...renderJobHeaderLines(job),
    ...renderJobHealthLines(job),
    ...renderJobRuntimeLines(job),
    ...renderProvenanceLines(job.provenance, job.request?.inputHash ?? null),
    ...renderJobErrorLines(job),
    ...renderPrintTimeoutNote(job.agyPrintTimeout),
    // `job.deniedActions` here is expected to already carry `remedy`
    // (status.mjs attaches it via job-helpers.mjs#deniedActionsWithRemedy
    // before calling this renderer) — a raw source/no-remedy list renders
    // `remedy: undefined` as the literal string "undefined", which is the
    // caller's contract to uphold, not this pure formatter's job to guess.
    ...renderDeniedActionLines(job.deniedActions),
    ...renderJobRecentProgressLines(job),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a stored job result for the /antigravity:result command.
 *
 * @param {string} cwd unused; kept for call-site compatibility
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {import('./types.mjs').JobRecord | null} storedJob the full stored job file data
 * @returns {string}
 */
export function renderResultOutput(cwd, job, storedJob) {
  // If there's raw text output, return it.
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.agy?.stdout === "string" && storedJob.result.agy.stdout) ||
    "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  // If there's pre-rendered output, return it.
  if (storedJob?.rendered) {
    return storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
  }

  // Fallback: build from job metadata.
  const lines = [
    `# ${job.title ?? "Antigravity Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a cancel report.
 *
 * @param {import('./types.mjs').JobIndexEntry} job
 * @returns {string}
 */
export function renderCancelReport(job) {
  const lines = [
    "# Antigravity Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.kind) {
    lines.push(`- Kind: ${job.kind}`);
  }
  lines.push(`- Status: ${job.status}`);

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Render a setup report.
 *
 * @param {{ agyAvailable: boolean, agyVersion?: string, authenticated?: boolean, authMethod?: string, npmAvailable?: boolean, reviewGate?: boolean, message?: string }} report
 * @returns {string}
 */
export function renderSetupReport(report) {
  const lines = [];
  lines.push("# Antigravity Setup");
  lines.push("");

  if (report.agyAvailable) {
    lines.push(`- agy CLI: installed${report.agyVersion ? ` (${report.agyVersion})` : ""}`);
  } else {
    lines.push("- agy CLI: **not installed**");
  }

  if (report.authenticated !== undefined) {
    lines.push(`- Authentication: ${report.authenticated ? "authenticated" : "**not authenticated**"}`);
    if (report.authMethod) {
      lines.push(`- Auth method: ${report.authMethod}`);
    }
  }

  if (report.npmAvailable !== undefined) {
    lines.push(`- npm: ${report.npmAvailable ? "available" : "not available"}`);
  }

  if (report.reviewGate !== undefined) {
    lines.push(`- Review gate: ${report.reviewGate ? "enabled" : "disabled"}`);
  }

  if (report.message) {
    lines.push("");
    lines.push(report.message);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Append extra display lines after `text`, one per array entry joined with
 * newlines, adding a newline first only when `text` does not already end in
 * one. `[]` returns `text` unchanged. Shared by every path that appends an
 * optional line or section after the answer without folding it into the
 * opaque `answer`/`rendered` text: the foreground `--check-locations` line
 * (Task 14, "Senate R8", 2026-09) is the first `finishForeground` caller to
 * need this. `result.mjs` keeps its own local `appendSectionLines`, the
 * same shape, for its several appended sections (denied actions,
 * print-timeout, findings, provenance) — not merged into this helper, since
 * that file builds its whole answer outside `finishForeground` entirely.
 *
 * @param {string} text
 * @param {string[]} lines
 * @returns {string}
 */
export function appendRenderedLines(text, lines) {
  if (lines.length === 0) return text;
  const separator = text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}${lines.join("\n")}\n`;
}

/**
 * Output either JSON or rendered markdown based on the --json flag.
 *
 * @param {import('./types.mjs').JsonEnvelopeV1} payload - The structured data.
 * @param {string} rendered - The markdown rendering.
 * @param {boolean} json - Whether to output JSON.
 * @returns {void}
 */
export function outputCommandResult(payload, rendered, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

/**
 * @param {{ startedAt?: string | null, createdAt?: string | null, completedAt?: string | null }} job
 * @returns {string}
 */
function computeElapsedDisplay(job) {
  const start = job.startedAt ?? job.createdAt;
  const end = job.completedAt ?? new Date().toISOString();
  if (!start) {
    return "-";
  }
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  }
  return `${Math.round(ms / 60000)}m`;
}
