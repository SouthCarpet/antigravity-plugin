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

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildReviewInput } from "../lib/review-input.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  EFFORT_CHOICES,
  probeAgyForVerb,
  rememberAgyVersion,
  reportAgyUnavailable,
  reportInvalidFocus,
  reportQueuedJob,
  resolveReviewEffort,
  resolveReviewFocus,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  waitAndExit,
  waitForJob,
} from "../lib/job-helpers.mjs";
import { createErrorEnvelope, createJsonEnvelope, outputCommandResult, renderReviewPreview } from "../lib/render.mjs";
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
 * @param {{ envelope: object, base: string | undefined, mode: string,
 *   model: string | undefined, effort: string | undefined, focus: string | undefined,
 *   input: ReturnType<import('../lib/review-input.mjs').buildReviewInput> }} args
 * @returns {object}
 */
function buildReviewRequestFields({ envelope, base, mode, model, effort, focus, input }) {
  return {
    scope: envelope.scope,
    base: base ?? null,
    mode,
    model,
    effort,
    focus,
    inputHash: input.inputHash,
    inputCounts: input.counts,
    headSha: input.headSha,
  };
}

async function runReviewBackground({ workspaceRoot, title, prompt, mode, conversationId, envelope, base, agyVersion, model, effort, focus, input, options, ctx }) {
  const { job } = await (ctx.startBackgroundJob ?? startBackgroundJob)({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode,
    conversationId,
    cwd: workspaceRoot,
    agyVersion,
    request: buildReviewRequestFields({ envelope, base, mode, model, effort, focus, input }),
  });
  const queuedExit = reportQueuedJob("review", job, options);
  if (queuedExit !== null) return queuedExit;
  if (!options.wait) return 0;
  return waitAndExit("review", workspaceRoot, job.id, ctx.waitForJob ?? waitForJob);
}

async function runReviewForeground({ workspaceRoot, title, prompt, mode, conversationId, envelope, base, agyVersion, model, effort, focus, input, json }) {
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
    request: buildReviewRequestFields({
      envelope,
      base,
      mode: retryConversationId ? "conversation" : mode,
      model,
      effort,
      focus,
      input,
    }),
    onText: (delta) => process.stderr.write(delta),
  });

  return runForegroundWithRetryPrompt("review", runOnce, {
    json,
    extraDetails: { scope: envelope.scope },
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
 * @param {string[]} [argv] CLI arguments after the verb (flags only)
 * @param {{ cwd?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["base", "scope", "conversation", "cwd", "model", "effort", "focus"],
    booleanOptions: ["background", "wait", "continue", "json", "preview", "require-complete"],
    valueChoices: { effort: EFFORT_CHOICES },
    conflicts: [
      ["continue", "conversation"],
      ["preview", "background"],
      ["preview", "wait"],
      ["preview", "continue"],
      ["preview", "conversation"],
    ],
  }, "review");
  if (!parsed) return 1;
  const { options } = parsed;

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scope = (options.scope ? String(options.scope) : "auto");
  const base = options.base ? String(options.base) : undefined;

  const { model, effort, focus, focusError } = resolveReviewFlagOptions(options);
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

  const input = buildReviewInput(envelope, { focus });
  const json = Boolean(options.json);

  if (options.preview) return reportReviewPreview(input, json);

  const incomplete = isReviewInputIncomplete(input);
  if (incomplete && options["require-complete"]) return reportInputIncomplete(input, json);
  if (incomplete) printIncompleteInputWarning(input);

  const probed = await probeAgyForVerb("review");
  if (probed.line) return reportAgyUnavailable("review", probed.line, json);
  await rememberAgyVersion(workspaceRoot, probed.version);

  const mode = resolveReviewMode(options);
  const conversationId = options.conversation ? String(options.conversation) : undefined;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}${focus ? ` focus: ${focus.slice(0, 40)}` : ""}`;

  const runArgs = {
    workspaceRoot, title, prompt: input.prompt, mode, conversationId, envelope, base,
    agyVersion: probed.version, model, effort, focus, input,
  };

  if (options.background) {
    return runReviewBackground({ ...runArgs, options, ctx });
  }

  return runReviewForeground({ ...runArgs, json });
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
