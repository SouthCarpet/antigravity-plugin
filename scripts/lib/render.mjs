/**
 * Output rendering — formats reviews, status, results, and reports as markdown.
 */

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
 * Echo runtime warnings to stderr on a completed run. The verbs only print
 * `result.stderr` on failure, so without this a benign denial would reach
 * the stored job and `--json` but never the terminal.
 *
 * @param {string} command
 * @param {{ warnings?: string[] }} result
 * @returns {void}
 */
export function reportWarnings(command, result) {
  for (const warning of warningDetails(result).warnings ?? []) {
    process.stderr.write(`antigravity:${command} — warning: ${warning}\n`);
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
 * Markdown lines for a denied-actions list already carrying `remedy`
 * (`job-helpers.mjs#deniedActionsWithRemedy`): one line per action under a
 * "## Denied Actions" heading, used by the single-job status view and by
 * `result` (plan 085 T2 item 4). Empty when there is nothing to show.
 *
 * @param {import('./types.mjs').DeniedActionWithRemedy[] | null | undefined} list
 * @returns {string[]}
 */
export function renderDeniedActionLines(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const lines = ["", "## Denied Actions", ""];
  for (const { action, displayName, remedy } of list) {
    const label = displayName ? `${action} (${displayName})` : action;
    lines.push(`- **${label}**: ${remedy}`);
  }
  return lines;
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
    lines.push("| Job ID | Kind | Status | Phase | Health | Last Progress | Elapsed | Summary | Denied |");
    lines.push("|--------|------|--------|-------|--------|---------------|---------|---------|--------|");
    for (const job of snapshot.running) {
      const elapsed = computeElapsedDisplay(job);
      lines.push(
        `| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${job.phase ?? "-"} | ${job.healthStatus ?? "-"} | ${job.lastProgressAt ?? "-"} | ${elapsed} | ${summaryForTableCell(job.summary)} | ${formatDeniedMarker(job)} |`
      );
    }
    lines.push("");
  }

  // Recent completed jobs.
  if (snapshot.recent.length > 0) {
    lines.push("## Recent Jobs");
    lines.push("");
    lines.push("| Job ID | Kind | Status | Duration | Size | Summary | Follow-up | Denied |");
    lines.push("|--------|------|--------|----------|------|---------|-----------|--------|");
    for (const job of snapshot.recent) {
      const duration = computeElapsedDisplay(job);
      const followUp = job.status === "completed" ? `/antigravity:result ${job.id}` : "-";
      lines.push(`| ${job.id} | ${job.kind ?? "-"} | ${job.status} | ${duration} | ${formatAnswerSize(job)} | ${summaryForTableCell(job.summary)} | ${followUp} | ${formatDeniedMarker(job)} |`);
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
    ...renderJobErrorLines(job),
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
