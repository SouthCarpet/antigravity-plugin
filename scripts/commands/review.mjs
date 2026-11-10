/**
 * /antigravity:review — read-only review of working tree or branch diff.
 *
 * Flags:
 *   --base <ref>      base ref for branch diff
 *   --scope <auto|working-tree|branch>
 *   --background      fire-and-forget worker, return immediately
 *   --wait            block until completion (foreground default)
 *   --continue        resume the last review conversation
 *   --conversation <id>  resume a specific conversation
 *   --model <id>      agy model id for this run
 *   --effort <low|medium|high|agy-default>  agy reasoning effort for this
 *                     run; unlike `task`/`rescue` there is no plugin
 *                     default: with neither flag, no `--effort` reaches agy;
 *                     `agy-default` sends none either
 *   --focus <text>    narrows the review's attention (never required, never
 *                     derived from repository content); trimmed, max 500
 *                     characters
 *   --preview         show what would be sent (included/skipped files,
 *                     counts, truncation, hash); no agy call, no state
 *                     change (Task 5, "Senate R5", 2026-09); conflicts with
 *                     --background, --wait, --continue, --conversation
 *   --require-complete  refuse to send an input with a skipped file or a
 *                     truncated diff, instead of sending it with a warning
 *   --show-result     after a background --wait completes, print the
 *                     finished job's own result instead of the dispatch
 *                     envelope (requires --wait and --background)
 *   --findings-json   also ask agy for structured findings under the
 *                     shipped schema (`--json-schema`) and validate them
 *                     locally into `details.findings` (Senate R7, 2026-09);
 *                     `answer` stays agy's response text, except Google
 *                     OAuth URLs become `[oauth-url-removed]`
 *   --check-locations heuristically check each `path:line` citation the
 *                     answer names against the sent diff's own hunks
 *                     (Task 14, "Senate R8", 2026-09); local only, adds
 *                     nothing to the agy call; see `review-locations.mjs`
 *   --models <a,b>    run the SAME review twice, against two different agy
 *                     models, and compare their structured findings (plan
 *                     153 p2, "E1"); each token is an exact model id or
 *                     `alias:<name>`; requires --findings-json; conflicts
 *                     with --model, --model-alias, --background, --wait,
 *                     --continue, --conversation, --show-result, --preview;
 *                     see `review-compare.mjs` for the match rule
 *   --json            output JSON instead of markdown
 *
 * The diff is collected first. An empty one answers `no_changes` with exit 0
 * from Git alone, so a machine without `agy` can still run this. Every
 * remaining path (foreground, background, `--preview`) then builds one
 * `buildReviewInput` record (`review-input.mjs`) — the single place that
 * decides what reaches agy, from the exact prompt string to the
 * included/skipped lists and the input hash. `agy` is probed only after
 * that, and only when the run is actually going to send something: never
 * for `--preview`, and never when `--require-complete` refuses first.
 */

import { randomBytes } from "node:crypto";

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildReviewInput } from "../lib/review-input.mjs";
import { REVIEW_FINDINGS_SCHEMA_PATH, reviewFindingsDetails } from "../lib/review-findings.mjs";
import { checkReviewLocations, locationCheckReportLine } from "../lib/review-locations.mjs";
import {
  compareReviewFindings, escapeControls, escapeForLine, parseModelsOption, resolveModelsPair,
} from "../lib/review-compare.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  EFFORT_CHOICES,
  deniedActionsWithRemedy,
  probeAgyForVerb,
  rememberAgyVersion,
  reportAgyUnavailable,
  reportArgsValidationError,
  reportInvalidFocus,
  reportQueuedJob,
  resolveReviewEffort,
  resolveRequestModel,
  reportModelResolutionFailure,
  resolveReviewFocus,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  validateShowResultDependency,
  waitAndReport,
  waitForJob,
} from "../lib/job-helpers.mjs";
import {
  createErrorEnvelope, createJsonEnvelope, outputCommandResult, redactBypassFlag, renderReviewPreview,
} from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

/**
 * @param {{ conversation?: string, continue?: boolean }} options
 * @returns {string}
 */
function resolveReviewMode(options) {
  if (options.conversation) return "conversation";
  if (options.continue) return "continue";
  return "print";
}

/**
 * The `request` fields common to the foreground and background review job
 * (Task 5, "Senate R5", 2026-09): the existing `scope`/`base`/`mode`/`model`/
 * `effort`/`focus` fields, plus `inputHash`, `inputCounts`, and `headSha`
 * straight off `buildReviewInput`'s own return value — never a second copy
 * of the diff or the prompt (that already lives at the top-level `prompt`
 * argument `runForegroundJob`/`startBackgroundJob` store as `request.prompt`
 * on the background path).
 *
 * `findingsJson: true` (Senate R7, 2026-09) is stored only for a
 * `--findings-json` run, so a request without the flag is unchanged; the
 * worker turns it back into `--json-schema`.
 *
 * `hunks` (Task 14, "Senate R8", 2026-09) is stored on every request,
 * unconditionally — not only under `--check-locations` — straight off
 * `buildReviewInput`'s own return value, so a job reviewed without the flag
 * can still be checked later with `result <id> --check-locations`.
 *
 * @param {{ envelope: object, base: string | undefined, mode: string,
 *   model: string | undefined, effort: string | undefined, focus: string | undefined,
 *   findingsJson: boolean,
 *   input: ReturnType<import('../lib/review-input.mjs').buildReviewInput> }} args
 * @returns {object}
 */
function buildReviewRequestFields({ envelope, base, mode, model, modelRequest, effort, focus, findingsJson, input }) {
  return {
    scope: envelope.scope,
    base: base ?? null,
    mode,
    model,
    ...modelRequest,
    effort,
    focus,
    inputHash: input.inputHash,
    inputCounts: input.counts,
    headSha: input.headSha,
    hunks: input.hunks,
    ...(findingsJson ? { findingsJson: true } : {}),
  };
}

async function runReviewBackground({ workspaceRoot, title, prompt, mode, conversationId, envelope, base, agyVersion, model, modelRequest, effort, focus, findingsJson, input, options, ctx }) {
  const { job } = await (ctx.startBackgroundJob ?? startBackgroundJob)({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode,
    conversationId,
    cwd: workspaceRoot,
    agyVersion,
    request: buildReviewRequestFields({ envelope, base, mode, model, modelRequest, effort, focus, findingsJson, input }),
  });
  const queuedExit = reportQueuedJob("review", job, options);
  if (queuedExit !== null) return queuedExit;
  if (!options.wait) return 0;
  return waitAndReport("review", workspaceRoot, job.id, ctx.waitForJob ?? waitForJob, {
    json: Boolean(options.json),
    showResult: Boolean(options["show-result"]),
  });
}

/**
 * The `finishForeground` options for review's two additive result-shaping
 * flags — `--findings-json` (Senate R7, 2026-09) and `--check-locations`
 * (Task 14, "Senate R8", 2026-09) — either, both, or neither active for one
 * run:
 *   - `resultDetails` always runs (an empty object when neither flag is
 *     set, so `finishForeground`'s merge is a no-op); it derives the
 *     findings fields off `result.structured` and/or `locationCheck` off
 *     `checkReviewLocations(result.stdout, hunks)`, the same `hunks`
 *     {@link buildReviewRequestFields} already stored on the job.
 *   - `--check-locations` alone also adds `extraStderrLines`/`renderedSuffix`
 *     for the one summary line ({@link locationCheckReportLine}); findings
 *     already prints its own warning line inside `finishForeground` and
 *     needs neither hook.
 *
 * @param {{ findingsJson: boolean, checkLocations: boolean,
 *   hunks: Array<{ path: string, newStart: number, newEnd: number }> }} args
 * @returns {{ resultDetails: (result: import('../lib/types.mjs').RuntimeResult) => object,
 *   extraStderrLines?: (result: import('../lib/types.mjs').RuntimeResult, ownDetails: object) => string[],
 *   renderedSuffix?: (result: import('../lib/types.mjs').RuntimeResult, ownDetails: object) => string[] }}
 */
function reviewFinishOptions({ findingsJson, checkLocations, hunks }) {
  const resultDetails = (result) => ({
    ...(findingsJson ? reviewFindingsDetails(result.structured) : {}),
    ...(checkLocations ? { locationCheck: checkReviewLocations(result.stdout, hunks) } : {}),
  });
  if (!checkLocations) return { resultDetails };
  const locationLines = (result, ownDetails) => [locationCheckReportLine("review", ownDetails.locationCheck)];
  return { resultDetails, extraStderrLines: locationLines, renderedSuffix: locationLines };
}

/**
 * The one stderr line `--models` prints before either leg dispatches: no prompt, no
 * confirmation, just the fact that two agy calls (two quotas) are about to
 * run.
 *
 * @returns {void}
 */
function printModelsCostNotice() {
  process.stderr.write("antigravity:review — two model calls will run (two agy calls, two quotas).\n");
}

/**
 * The `request` fields one `--models` leg stores: the same fields a single-model review stores
 * ({@link buildReviewRequestFields}), always `mode: "print"` ("each leg is
 * a fresh conversation"), always `findingsJson: true` (required by the
 * conflict rule), plus the shared `pairId` linking both legs' job records.
 *
 * @param {{ envelope: object, base: string | undefined, model: string, modelRequest: object,
 *   effort: string | undefined, focus: string | undefined,
 *   input: ReturnType<import('../lib/review-input.mjs').buildReviewInput>, pairId: string }} args
 * @returns {object}
 */
function buildPairedRequestFields({ envelope, base, model, modelRequest, effort, focus, input, pairId }) {
  return {
    scope: envelope.scope,
    base: base ?? null,
    mode: "print",
    model,
    ...modelRequest,
    effort,
    focus,
    inputHash: input.inputHash,
    inputCounts: input.counts,
    headSha: input.headSha,
    hunks: input.hunks,
    findingsJson: true,
    pairId,
  };
}

/**
 * The exit code one `--models` leg contributes (same mapping
 * `finishForeground`'s non-completed branches already use: `cancelled` is
 * 2, every other non-completed status is 1, `completed` is 0). A leg that
 * never ran ("not_run", the authentication halt case) contributes 0: it
 * can only ever follow a leg that already halted the pair with its own
 * non-zero code, so it is never the first non-zero leg.
 *
 * @param {string} status
 * @returns {0 | 1 | 2}
 */
function pairedLegExitCode(status) {
  if (status === "completed" || status === "not_run") return 0;
  return status === "cancelled" ? 2 : 1;
}

/**
 * The `jobs[]` entry for one `--models` leg that actually ran: `id`,
 * `model`, the run `status` (both legs are always listed),
 * and, only once the leg completed,
 * `findingsStatus` (plus a one-line `findingsError` when it is not
 * `"valid"`, and `locationCheck` when `--check-locations` was given — "one
 * check per leg, results under each leg"). `deniedActions` (with remedy, the
 * shape a single-model `--json` review reports) is present on any leg whose
 * run reported a denied action, whatever its status. The full findings array is kept
 * only on the internal record ({@link runReviewPairedCommand}'s `legs`),
 * never duplicated into this envelope entry: a caller who wants the full
 * list for one leg already has its job `id` for `/antigravity:result`.
 *
 * @param {string} model
 * @param {{ id: string }} job
 * @param {import('../lib/types.mjs').RuntimeResult} result
 * @param {boolean} checkLocations
 * @param {Array<{ path: string, newStart: number, newEnd: number }>} hunks
 * @returns {{ id: string, model: string, status: string, findingsStatus: string | null, findings?: object | null,
 *   findingsError?: string, locationCheck?: object | null,
 *   deniedActions?: import('../lib/types.mjs').DeniedActionWithRemedy[] }}
 */
function buildPairedLeg(model, job, result, checkLocations, hunks) {
  const entry = { id: job.id, model, status: result.status, findingsStatus: null };
  const deniedActions = deniedActionsWithRemedy(result.deniedActions, "review");
  if (deniedActions) entry.deniedActions = deniedActions;
  if (result.status !== "completed") return entry;
  const findingsDetails = reviewFindingsDetails(result.structured);
  entry.findingsStatus = findingsDetails.findingsStatus;
  entry.findings = findingsDetails.findings;
  if (findingsDetails.findingsError) entry.findingsError = findingsDetails.findingsError;
  if (checkLocations) entry.locationCheck = checkReviewLocations(result.stdout, hunks);
  return entry;
}

/**
 * `jobs[]` as the `--json`/markdown envelope reports it: every field
 * {@link buildPairedLeg} computed except the full `findings` array, which
 * stays internal (see that function's doc comment).
 *
 * @param {ReturnType<typeof buildPairedLeg>} leg
 * @returns {object}
 */
function stripPairedLegFindings({ findings: _findings, ...rest }) {
  return rest;
}

/**
 * The `comparison` field: `null`
 * unless both legs completed with valid findings,
 * else {@link compareReviewFindings} against the diff's own hunks (shared
 * identically by both legs, "Mechanics"). `leg.findings` is the WHOLE
 * validated `review-findings.schema.json` document
 * (`{verdict, summary, findings: [...]}`, see `review-findings.mjs`'s own
 * `reviewFindingsDetails`), so the array to compare is its own `.findings`
 * key, not `leg.findings` itself.
 *
 * @param {[ReturnType<typeof buildPairedLeg>, ReturnType<typeof buildPairedLeg>]} legs
 * @param {Array<{ path: string, newStart: number, newEnd: number }>} hunks
 * @returns {{ bothFlagged: Array<{a: object, b: object}>, onlyA: object[], onlyB: object[] } | null}
 */
function computePairedComparison([legA, legB], hunks) {
  if (legA.findingsStatus !== "valid" || legB.findingsStatus !== "valid") return null;
  return compareReviewFindings(legA.findings.findings, legB.findings.findings, hunks);
}

/**
 * One denied action on one line, for stderr and the markdown summary: the
 * action, its display name and its target (model-chosen text) are each cut
 * and JSON-escaped by {@link escapeForLine}; the remedy sentence is
 * escaped by {@link escapeControls}. The result is never longer than one line.
 *
 * @param {{ action: string, displayName?: string | null, target?: string | null, remedy: string }} entry
 * @returns {string}
 */
function pairedDenialText({ action, displayName, target, remedy }) {
  const name = displayName ? ` (${escapeForLine(displayName)})` : "";
  const where = target ? ` for ${escapeForLine(target)}` : "";
  return `denied ${escapeForLine(action)}${name}${where}: ${escapeControls(remedy)}`;
}

/**
 * Echo a leg's denied actions to stderr, one redacted line each, as a
 * single-model review does (`reportDeniedActionHints`), with the model named
 * because two legs share one stderr.
 *
 * @param {ReturnType<typeof buildPairedLeg>} leg
 * @returns {void}
 */
function reportPairedDenials(leg) {
  for (const entry of leg.deniedActions ?? []) {
    process.stderr.write(redactBypassFlag(`antigravity:review — ${escapeForLine(leg.model)} ${pairedDenialText(entry)}\n`));
  }
}

/**
 * The markdown rendering for `--models`' paired envelope: one line per leg,
 * then the comparison counts or a note that comparison is unavailable.
 * Kept local because only paired reviews use this rendering.
 *
 * @param {{ pairId: string, jobs: object[], comparison: object | null }} details
 * @returns {string}
 */
function renderReviewPairedMarkdown(details) {
  const lines = [`# antigravity review — paired (${details.pairId})`, ""];
  for (const job of details.jobs) {
    const label = escapeForLine(job.model);
    const jobLine = job.id ? `${label}: ${job.status} (job ${job.id})` : `${label}: ${job.status}`;
    lines.push(`- ${jobLine}${job.findingsStatus ? `, findings ${job.findingsStatus}` : ""}`);
    for (const entry of job.deniedActions ?? []) lines.push(`  - ${redactBypassFlag(pairedDenialText(entry))}`);
  }
  lines.push("");
  lines.push(details.comparison
    ? `Comparison: ${details.comparison.bothFlagged.length} both flagged, ` +
      `${details.comparison.onlyA.length} only model A, ${details.comparison.onlyB.length} only model B.`
    : "Comparison: unavailable (one or both legs did not return valid findings).");
  return `${lines.join("\n")}\n`;
}

/**
 * Report `--models`' paired envelope and compute the command's exit code
 * (the first non-zero leg exit code, else 0).
 *
 * @param {{ pairId: string, legs: Array<ReturnType<typeof buildPairedLeg>>,
 *   hunks: Array<{ path: string, newStart: number, newEnd: number }>, json: boolean }} args
 * @returns {number}
 */
function reportReviewPaired({ pairId, legs, hunks, json }) {
  for (const leg of legs) reportPairedDenials(leg);
  const comparison = computePairedComparison(legs, hunks);
  const details = { pairId, jobs: legs.map(stripPairedLegFindings), comparison };
  outputCommandResult(
    createJsonEnvelope("review", { status: "paired", jobId: null, answer: null, details }),
    renderReviewPairedMarkdown(details),
    json,
  );
  return legs.map((leg) => pairedLegExitCode(leg.status)).find((code) => code !== 0) ?? 0;
}

/**
 * The `--models` checks that need no diff and no agy: `--findings-json` is
 * required, and the value must be two distinct, well-formed tokens
 * ({@link parseModelsOption}). Run before the empty-diff early return, so a
 * malformed call is refused whatever the diff holds. Refused with
 * {@link reportArgsValidationError} (no `--json` envelope, matching every
 * other "flag A requires flag B"/malformed-value refusal this verb has).
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @returns {{ code: number } | { tokens: [string, string] }}
 */
function checkPairedOptions(options) {
  if (!options["findings-json"]) {
    return { code: reportArgsValidationError("review", "--models needs --findings-json to compare structured findings") };
  }
  const parsedModels = parseModelsOption(String(options.models));
  if (!parsedModels.ok) return { code: reportArgsValidationError("review", parsedModels.reason) };
  return { tokens: parsedModels.tokens };
}

/**
 * `review --models <a,b>`: one shared
 * `buildReviewInput` call already ran in `run()`; this resolves the two
 * model tokens, prints the cost notice, then runs each leg's OWN fresh
 * `runForegroundJob` call in order, halting before the second leg only
 * when the first leg reports `auth_required` (a
 * sign-in failure is not model-specific, so the second leg would only
 * hit it again) — every other non-completed first-leg status still lets
 * the second leg run.
 *
 * `--findings-json`'s own requirement and `--models`' value shape are
 * refused earlier, in {@link checkPairedOptions}, before the diff is read.
 * A model-resolution failure (unknown alias, listing
 * unavailable) also refuses before either leg exists, through the same
 * {@link reportModelResolutionFailure} a single-model `--model-alias`
 * failure already uses — there is nothing "paired" to report yet.
 *
 * @param {{ workspaceRoot: string, envelope: object, base: string | undefined,
 *   effort: string | undefined, focus: string | undefined,
 *   checkLocations: boolean, tokens: [string, string],
 *   input: ReturnType<import('../lib/review-input.mjs').buildReviewInput>, json: boolean }} args
 * @returns {Promise<number>}
 */
async function runReviewPairedCommand({
  workspaceRoot, envelope, base, effort, focus, checkLocations, tokens, input, json,
}) {
  const probed = await probeAgyForVerb("review");
  if (probed.line) return reportAgyUnavailable("review", probed.line, json);
  await rememberAgyVersion(workspaceRoot, probed.version);
  const agyVersion = probed.version;

  const pairResolution = await resolveModelsPair(tokens, { effort });
  if (!pairResolution.ok) return reportModelResolutionFailure("review", pairResolution, json);

  printModelsCostNotice();

  const pairId = randomBytes(6).toString("hex");
  const legs = [];
  let haltedEarly = false;
  for (const [index, { model, request: modelRequest }] of pairResolution.resolved.entries()) {
    if (haltedEarly) {
      legs.push({ id: null, model, status: "not_run", findingsStatus: null });
      continue;
    }
    const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""} (models pair ${index + 1}/2: ${model})`;
    const { job, result } = await runForegroundJob({
      workspaceRoot,
      kind: "review",
      title,
      prompt: input.prompt,
      mode: "print",
      cwd: workspaceRoot,
      agyVersion,
      model,
      effort,
      jsonSchemaPath: REVIEW_FINDINGS_SCHEMA_PATH,
      request: buildPairedRequestFields({ envelope, base, model, modelRequest, effort, focus, input, pairId }),
      onText: (delta) => process.stderr.write(delta),
    });
    legs.push(buildPairedLeg(model, job, result, checkLocations, input.hunks));
    if (result.status === "auth_required") haltedEarly = true;
  }

  return reportReviewPaired({ pairId, legs, hunks: input.hunks, json });
}

async function runReviewForeground({
  workspaceRoot, title, prompt, mode, conversationId, envelope, base, agyVersion, model, modelRequest, effort, focus,
  findingsJson, checkLocations, input, json,
}) {
  const runOnce = (retryConversationId) => runForegroundJob({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode: retryConversationId ? "conversation" : mode,
    conversationId: retryConversationId ?? conversationId,
    cwd: workspaceRoot,
    agyVersion,
    model,
    effort,
    jsonSchemaPath: findingsJson ? REVIEW_FINDINGS_SCHEMA_PATH : undefined,
    request: buildReviewRequestFields({
      envelope,
      base,
      mode: retryConversationId ? "conversation" : mode,
      model,
      modelRequest,
      effort,
      focus,
      findingsJson,
      input,
    }),
    onText: (delta) => process.stderr.write(delta),
  });

  return runForegroundWithRetryPrompt("review", runOnce, {
    json,
    extraDetails: { scope: envelope.scope },
    ...reviewFinishOptions({ findingsJson, checkLocations, hunks: input.hunks }),
  });
}

/**
 * Resolve `review`'s three additive flags (Task 4, "Senate R4", 2026-09) off
 * the parsed CLI options, split out of `run` to keep it under the
 * complexity ceiling: `--model` (verbatim string or `undefined`), `--effort`
 * (via {@link resolveReviewEffort}, which has no plugin default), and
 * `--focus` (via {@link resolveReviewFocus}, already trimmed and capped).
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @returns {{ model: string | undefined, effort: string | undefined,
 *   focus: string | undefined, focusError: string | null }}
 */
function resolveReviewFlagOptions(options) {
  const model = options.model ? String(options.model) : undefined;
  const effort = resolveReviewEffort(options.effort);
  const { focus, error: focusError } = resolveReviewFocus(options.focus);
  return { model, effort, focus, focusError };
}

/**
 * True when `buildReviewInput`'s own record left something out of the
 * prompt: a skipped file, or a diff cut by the 196 KiB cap (Task 5, "Senate
 * R5", 2026-09). The one condition both the incomplete-input warning and
 * `--require-complete`'s refusal gate on, so the two can never disagree
 * about what counts as "incomplete".
 *
 * @param {ReturnType<import('../lib/review-input.mjs').buildReviewInput>} input
 * @returns {boolean}
 */
function isReviewInputIncomplete(input) {
  return input.skipped.length > 0 || input.truncated.diff;
}

/**
 * Print the one stderr warning line for a normal run whose input is
 * incomplete (Task 5, "Senate R5", 2026-09): printed once, before the agy
 * probe or any spawn.
 *
 * @param {ReturnType<import('../lib/review-input.mjs').buildReviewInput>} input
 * @returns {void}
 */
function printIncompleteInputWarning(input) {
  process.stderr.write(
    `antigravity:review — warning: input is incomplete (${input.skipped.length} files skipped, ` +
      `diff truncated by ${input.truncated.droppedBytes} bytes); run review --preview for the list.\n`,
  );
}

/**
 * Report `--require-complete`'s refusal (Task 5, "Senate R5", 2026-09): the
 * plugin's own one-line reason on stderr, plus the Task 3 `invalid_input`
 * `--json` envelope (`error.code: "input_incomplete"`, phase `collect`),
 * before any agy probe or spawn. Exit 1, same as every other validation
 * failure this verb reports.
 *
 * @param {ReturnType<import('../lib/review-input.mjs').buildReviewInput>} input
 * @param {boolean} json
 * @returns {1}
 */
function reportInputIncomplete(input, json) {
  const message = "input is incomplete; --require-complete refused to send it.";
  process.stderr.write(`antigravity:review — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope("review", {
      status: "invalid_input",
      error: { code: "input_incomplete", phase: "collect", message },
      details: { skipped: input.skipped, truncated: input.truncated },
    }),
    "",
    json,
  );
  return 1;
}

/**
 * Report `--preview` (Task 5, "Senate R5", 2026-09): the included/skipped
 * lists, counts, truncation state, and hash `buildReviewInput` already
 * computed. No agy probe, no spawn, no state change, exit 0 always.
 *
 * @param {ReturnType<import('../lib/review-input.mjs').buildReviewInput>} input
 * @param {boolean} json
 * @returns {0}
 */
function reportReviewPreview(input, json) {
  outputCommandResult(
    createJsonEnvelope("review", {
      status: "preview",
      jobId: null,
      answer: null,
      details: {
        included: input.included,
        skipped: input.skipped,
        truncated: input.truncated,
        counts: input.counts,
        inputHash: input.inputHash,
        scope: input.scope,
        base: input.base,
        headSha: input.headSha,
      },
    }),
    renderReviewPreview(input),
    json,
  );
  return 0;
}

/**
 * The single-model dispatch tail of `run()` (resolve `--model`/
 * `--model-alias`, probe agy, then background or foreground), split out so
 * `run()` itself stays under the complexity ceiling: this function holds
 * every decision point that belonged to this tail already, unchanged, plus
 * none of `--models`' own (that path never reaches here at all).
 *
 * @param {{ options: Record<string, string | boolean | string[]>, ctx: object,
 *   workspaceRoot: string, envelope: object, base: string | undefined,
 *   focus: string | undefined, findingsJson: boolean, checkLocations: boolean,
 *   input: ReturnType<import('../lib/review-input.mjs').buildReviewInput>, json: boolean }} args
 * @returns {Promise<number>}
 */
async function runReviewSingleModel({
  options, ctx, workspaceRoot, envelope, base, focus, findingsJson, checkLocations, input, json,
}) {
  const selection = await resolveRequestModel({ modelOption: options.model, aliasOption: options["model-alias"],
    effort: options.effort });
  if (!selection.ok) return reportModelResolutionFailure("review", selection, json);
  const model = selection.model;
  const effort = resolveReviewEffort(options.effort);
  const modelRequest = selection.request;
  const probed = await probeAgyForVerb("review");
  if (probed.line) return reportAgyUnavailable("review", probed.line, json);
  await rememberAgyVersion(workspaceRoot, probed.version);

  const mode = resolveReviewMode(options);
  const conversationId = options.conversation ? String(options.conversation) : undefined;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}${focus ? ` focus: ${focus.slice(0, 40)}` : ""}`;

  const runArgs = {
    workspaceRoot, title, prompt: input.prompt, mode, conversationId, envelope, base,
    agyVersion: probed.version, model, modelRequest, effort, focus, findingsJson, checkLocations, input,
  };

  if (options.background) {
    return runReviewBackground({ ...runArgs, options, ctx });
  }

  return runReviewForeground({ ...runArgs, json });
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (flags only)
 * @param {{ cwd?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["base", "scope", "conversation", "cwd", "model", "model-alias", "effort", "focus", "models"],
    booleanOptions: [
      "background", "wait", "continue", "json", "preview", "require-complete", "show-result", "findings-json",
      "check-locations",
    ],
    valueChoices: { effort: EFFORT_CHOICES },
    conflicts: [
      ["model", "model-alias"],
      ["continue", "conversation"],
      ["preview", "background"],
      ["preview", "wait"],
      ["preview", "continue"],
      ["preview", "conversation"],
      // --models: each leg is a fresh print
      // conversation, built and dispatched by `runReviewPairedCommand`
      // itself, so none of the single-model flags below apply to it.
      ["models", "model"],
      ["models", "model-alias"],
      ["models", "background"],
      ["models", "wait"],
      ["models", "continue"],
      ["models", "conversation"],
      ["models", "show-result"],
      ["models", "preview"],
    ],
  }, "review");
  if (!parsed) return 1;
  const { options } = parsed;

  const showResultError = validateShowResultDependency(options, "review");
  if (showResultError) return reportArgsValidationError("review", showResultError);

  const pairedCheck = options.models === undefined ? null : checkPairedOptions(options);
  if (pairedCheck && "code" in pairedCheck) return pairedCheck.code;

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scope = (options.scope ? String(options.scope) : "auto");
  const base = options.base ? String(options.base) : undefined;

  const { effort, focus, focusError } = resolveReviewFlagOptions(options);
  if (focusError) return reportInvalidFocus(focusError, Boolean(options.json));

  let envelope;
  try {
    envelope = collectReviewContext(workspaceRoot, { scope, base });
  } catch (err) {
    return reportReviewCollectionFailure(err, Boolean(options.json));
  }

  if (!hasReviewableContent(envelope.context)) {
    outputCommandResult(
      createJsonEnvelope("review", {
        status: "no_changes",
        details: { scope: envelope.scope },
      }),
      "antigravity:review — no changes to review.\n",
      Boolean(options.json),
    );
    return 0;
  }

  const findingsJson = Boolean(options["findings-json"]);
  const input = buildReviewInput(envelope, { focus, findingsJson });
  const json = Boolean(options.json);

  if (options.preview) return reportReviewPreview(input, json);

  const incomplete = isReviewInputIncomplete(input);
  if (incomplete && options["require-complete"]) return reportInputIncomplete(input, json);
  if (incomplete) printIncompleteInputWarning(input);

  const checkLocations = Boolean(options["check-locations"]);

  if (pairedCheck) {
    return runReviewPairedCommand({
      workspaceRoot, envelope, base, effort, focus, checkLocations, tokens: pairedCheck.tokens, input, json,
    });
  }

  return runReviewSingleModel({ options, ctx, workspaceRoot, envelope, base, focus, findingsJson, checkLocations, input, json });
}

/**
 * The `error.code` for a `collectReviewContext` failure (Task 3, "Senate
 * R1", 2026-09): the two validation shapes `git.mjs` throws today
 * (`collectReviewContext`'s own scope check, `resolveBaseCommit`'s ref
 * check), or a generic collection failure for anything else (a missing
 * `git` binary, a spawn error) — never invented from a message this module
 * has not actually seen thrown.
 *
 * @param {string} message
 * @returns {string}
 */
function classifyReviewCollectionError(message) {
  if (message.startsWith("Invalid scope")) return "invalid_scope";
  if (message.startsWith("unknown base ref")) return "unknown_base_ref";
  return "review_collection_failed";
}

/**
 * Report a `collectReviewContext` failure: the existing stderr line,
 * unchanged, plus (Task 3, "Senate R1", 2026-09) one `invalid_input`
 * `--json` envelope when `json` is true.
 *
 * @param {unknown} err
 * @param {boolean} json
 * @returns {1}
 */
function reportReviewCollectionFailure(err, json) {
  const message = err?.message ?? String(err);
  process.stderr.write(`antigravity:review — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope("review", {
      status: "invalid_input",
      error: { code: classifyReviewCollectionError(message), phase: "collect", message },
    }),
    "",
    json,
  );
  return 1;
}

/**
 * True when the collected context has a non-empty tracked diff or any
 * untracked snippets. Untracked-only trees produce no `git diff` — they
 * arrive in `context.untrackedContents` — and are still reviewable.
 *
 * @param {{ diff?: string, untrackedContents?: unknown[] } | null | undefined} context
 */
function hasReviewableContent(context) {
  if (!context) return false;
  if (typeof context.diff === "string" && context.diff.trim() !== "") return true;
  return Array.isArray(context.untrackedContents) && context.untrackedContents.length > 0;
}

export default run;

runIfMain(import.meta.url, run);
