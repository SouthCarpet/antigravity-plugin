/**
 * /antigravity:task — free-form prompt with state tracking.
 *
 * Defaults to BACKGROUND. Use --wait to block on completion or pass
 * --foreground to run inline. See /antigravity:rescue for the foreground-by-
 * default variant.
 *
 * Flags:
 *   --wait                block until completion
 *   --foreground          run inline instead of forking a worker
 *   --background          keep the default background path (conflicts with --foreground)
 *   --continue            resume the most recent agy conversation
 *   --conversation <id>   resume a specific conversation
 *   --add-dir <path>      additional workspace dir (repeatable)
 *   --mode <plan|accept-edits>  agy execution mode for this run
 *   --model <id>          agy model id for this run
 *   --effort <low|medium|high|agy-default>  agy reasoning effort for this run;
 *                         medium when absent and no --model is given; with
 *                         --model and no --effort no flag is sent (the model
 *                         id decides); agy-default sends no --effort flag at
 *                         all
 *   --show-result         after a background --wait completes, print the
 *                         finished job's own result instead of the dispatch
 *                         envelope (requires --wait; refused with
 *                         --foreground, which has no --wait semantics)
 *   --request-id <id>     idempotent background dispatch: a repeat of the
 *                         same request with the same id reports the existing
 *                         job instead of starting a new one; the same id with
 *                         a different request is refused (background only)
 *   --prompt-file <path>  read the prompt from a file instead of a
 *                         positional argument (cannot combine with one);
 *                         `-` reads stdin, standalone CLI only
 *   --json                emit JSON
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildTaskPrompt } from "../lib/prompt-templates.mjs";
import {
  AGY_MODES,
  EFFORT_CHOICES,
  agyModeArgs,
  probeAgyForVerb,
  rememberAgyVersion,
  reportAgyUnavailable,
  reportArgsValidationError,
  reportMissingTaskText,
  reportBackgroundStart,
  resolveRequestEffort,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  validateShowResultDependency,
  waitAndReport,
  waitForJob,
} from "../lib/job-helpers.mjs";
import { createErrorEnvelope, outputCommandResult } from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";
import { validateRequestIdOption } from "../lib/request-id.mjs";
import { resolvePromptFileSource, titleFromPromptText, validatePromptFileOption } from "../lib/prompt-source.mjs";

/**
 * @param {{ conversation?: string, continue?: boolean }} options
 * @returns {{ mode: string, conversationId: string | undefined }}
 */
function resolveTaskMode(options) {
  if (options.conversation) return { mode: "conversation", conversationId: String(options.conversation) };
  if (options.continue) return { mode: "continue", conversationId: undefined };
  return { mode: "print", conversationId: undefined };
}

async function runTaskForeground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, effort, agyVersion, json }) {
  const runOnce = (retryConversationId) => runForegroundJob({
    workspaceRoot,
    kind: "task",
    title,
    prompt,
    mode: retryConversationId ? "conversation" : mode,
    conversationId: retryConversationId ?? conversationId,
    addDirs,
    model,
    effort,
    extraArgs,
    cwd: workspaceRoot,
    agyVersion,
    request: { prompt, mode: retryConversationId ? "conversation" : mode, addDirs, model, effort },
    onText: (delta) => process.stderr.write(delta),
  });

  return runForegroundWithRetryPrompt("task", runOnce, { json });
}

async function runTaskBackground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, effort, agyVersion, options, ctx }) {
  const start = ctx.startBackgroundJob ?? startBackgroundJob;
  const wait = ctx.waitForJob ?? waitForJob;
  const started = await start({
    workspaceRoot,
    kind: "task",
    title,
    prompt,
    mode,
    conversationId,
    addDirs,
    extraArgs,
    cwd: workspaceRoot,
    agyVersion,
    request: { mode, addDirs, model, effort },
    requestId: options["request-id"] ?? null,
  });
  const { exit, jobId } = reportBackgroundStart("task", started, options);
  if (exit !== null) return exit;

  if (!options.wait) return 0;
  return waitAndReport("task", workspaceRoot, jobId, wait, {
    json: Boolean(options.json),
    showResult: Boolean(options["show-result"]),
  });
}

/**
 * Report a `--prompt-file`/stdin content failure ({@link resolvePromptFileSource}):
 * the plugin's own one-line reason on stderr (never the path or the file's
 * content, per SECURITY.md), plus one `invalid_input` `--json` envelope
 * when `json` is true. Same shape as `vision.mjs`'s
 * `reportVisionValidationFailure`.
 *
 * @param {{ code: string, message: string }} failure
 * @param {boolean} json
 * @returns {1}
 */
function reportPromptFileError({ code, message }, json) {
  process.stderr.write(`antigravity:task — ${message}\n`);
  outputCommandResult(
    createErrorEnvelope("task", {
      status: "invalid_input",
      error: { code, phase: "validate", message },
    }),
    "",
    json,
  );
  return 1;
}

/**
 * Resolve `task`'s prompt text and title: from `--prompt-file`/stdin when
 * given, otherwise from the joined positionals (unchanged behaviour). Split
 * out of `run()` so that function stays a plain sequence of checks under
 * the project's cyclomatic-complexity ceiling.
 *
 * @param {{ options: Record<string, string | boolean | string[]>, positionals: string[] }} parsed
 * @param {string} cwd invocation cwd
 * @param {string | undefined} conversationId
 * @param {boolean} json
 * @returns {Promise<{ ok: true, userPrompt: string, title: string | null } | { ok: false, exitCode: 1 }>}
 */
async function resolveTaskPromptAndTitle({ options, positionals }, cwd, conversationId, json) {
  const promptSource = await resolvePromptFileSource(options, cwd);
  if (promptSource) {
    if (!promptSource.ok) {
      reportPromptFileError(promptSource, json);
      return { ok: false, exitCode: 1 };
    }
    return { ok: true, userPrompt: promptSource.text, title: titleFromPromptText(promptSource.text) };
  }

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.continue && !options.conversation) {
    reportMissingTaskText("task", json);
    return { ok: false, exitCode: 1 };
  }
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;
  return { ok: true, userPrompt, title };
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a prompt and flags)
 * @param {{ cwd?: string, host?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`/`host`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["conversation", "cwd", "add-dir", "mode", "model", "effort", "request-id", "prompt-file"],
    booleanOptions: ["wait", "foreground", "background", "continue", "json", "show-result"],
    repeatableOptions: ["add-dir"],
    valueChoices: { mode: AGY_MODES, effort: EFFORT_CHOICES },
    conflicts: [
      ["foreground", "background"],
      ["continue", "conversation"],
    ],
    validate: (options) => validateRequestIdOption(options, "task"),
  }, "task");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const promptFileError = validatePromptFileOption(parsed, ctx);
  if (promptFileError) return reportArgsValidationError("task", promptFileError);

  const showResultError = validateShowResultDependency(options, "task");
  if (showResultError) return reportArgsValidationError("task", showResultError);

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const { mode, conversationId } = resolveTaskMode(options);

  const resolved = await resolveTaskPromptAndTitle({ options, positionals }, cwd, conversationId, Boolean(options.json));
  if (!resolved.ok) return resolved.exitCode;
  const { userPrompt, title } = resolved;

  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);
  const model = options.model ? String(options.model) : undefined;
  const effort = resolveRequestEffort(options.effort, model);

  const prompt = buildTaskPrompt(userPrompt || "(continue)");

  const probed = await probeAgyForVerb("task");
  if (probed.line) return reportAgyUnavailable("task", probed.line, options.json);
  await rememberAgyVersion(workspaceRoot, probed.version);

  const runArgs = { workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, effort, agyVersion: probed.version };

  if (options.foreground) {
    return runTaskForeground({ ...runArgs, json: options.json });
  }

  return runTaskBackground({ ...runArgs, options, ctx });
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runIfMain(import.meta.url, run);
