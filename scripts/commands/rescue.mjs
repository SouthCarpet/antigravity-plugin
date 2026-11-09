/**
 * /antigravity:rescue — hand a free-form task off to Antigravity (agy).
 *
 * Positional: prompt text.
 * Flags:
 *   --background          fork worker, return immediately
 *   --wait                block until the job finishes
 *   --resume              continue the most recent agy conversation
 *   --fresh               start a new conversation (default if --resume not given)
 *   --continue            alias of --resume (parity with agy)
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
 *                         envelope (requires --wait and --background)
 *   --request-id <id>     idempotent background dispatch (requires
 *                         --background): a repeat of the same request with
 *                         the same id reports the existing job instead of
 *                         starting a new one; the same id with a different
 *                         request is refused
 *   --json                emit JSON instead of markdown
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildRescuePrompt } from "../lib/prompt-templates.mjs";
import {
  reportRunPreview,
  previewConflicts,
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
  resolveRequestModel,
  reportModelResolutionFailure,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  validateShowResultDependency,
  waitAndReport,
  waitForJob,
} from "../lib/job-helpers.mjs";
import { createErrorEnvelope, outputCommandResult } from "../lib/render.mjs";
import { resolvePromptFileSource, titleFromPromptText, validatePromptFileOption } from "../lib/prompt-source.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";
import { validateRequestIdOption } from "../lib/request-id.mjs";

/**
 * Resolve conversation mode: `--conversation` wins; then `--resume`/
 * `--continue` (unless `--fresh`); else a fresh conversation.
 *
 * @param {{ conversation?: string, resume?: boolean, continue?: boolean, fresh?: boolean }} options
 * @returns {{ mode: string, conversationId: string | undefined }}
 */
function resolveRescueMode(options) {
  if (options.conversation) return { mode: "conversation", conversationId: String(options.conversation) };
  if ((options.resume || options.continue) && !options.fresh) return { mode: "continue", conversationId: undefined };
  return { mode: "print", conversationId: undefined };
}

async function runRescueForeground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, modelRequest, effort, agyVersion, json }) {
  const runOnce = (retryConversationId) => runForegroundJob({
    workspaceRoot,
    kind: "rescue",
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
    request: { mode: retryConversationId ? "conversation" : mode, addDirs, model, ...modelRequest, effort },
    onText: (delta) => process.stderr.write(delta),
  });

  return runForegroundWithRetryPrompt("rescue", runOnce, { json });
}

async function runRescueBackground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, modelRequest, effort, agyVersion, options, ctx }) {
  const started = await (ctx.startBackgroundJob ?? startBackgroundJob)({
    workspaceRoot,
    kind: "rescue",
    title,
    prompt,
    mode,
    conversationId,
    addDirs,
    extraArgs,
    cwd: workspaceRoot,
    agyVersion,
    request: { mode, addDirs, model, ...modelRequest, effort },
    requestId: options["request-id"] ?? null,
  });
  const { exit, jobId } = reportBackgroundStart("rescue", started, options);
  if (exit !== null) return exit;
  if (!options.wait) return 0;
  return waitAndReport("rescue", workspaceRoot, jobId, ctx.waitForJob ?? waitForJob, {
    json: Boolean(options.json),
    showResult: Boolean(options["show-result"]),
  });
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a prompt and flags)
 * @param {{ cwd?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["conversation", "model", "model-alias", "cwd", "add-dir", "mode", "effort", "request-id", "prompt-file"],
    booleanOptions: ["preview", "background", "wait", "resume", "continue", "fresh", "json", "show-result"],
    repeatableOptions: ["add-dir"],
    valueChoices: { mode: AGY_MODES, effort: EFFORT_CHOICES },
    conflicts: [
      ...previewConflicts(["background", "wait", "continue", "conversation", "request-id", "show-result", "resume"]),
      ["model", "model-alias"],
      ["continue", "conversation"],
      ["resume", "conversation"],
      ["fresh", "resume"],
      ["fresh", "continue"],
      ["fresh", "conversation"],
    ],
    validate: (options) => validateRequestIdOption(options, "rescue"),
  }, "rescue");
  if (!parsed) return 1;
  const { options } = parsed;

  const promptFileError = validatePromptFileOption(parsed, ctx);
  if (promptFileError) return reportArgsValidationError("rescue", promptFileError);

  const showResultError = validateShowResultDependency(options, "rescue");
  if (showResultError) return reportArgsValidationError("rescue", showResultError);

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = options.preview ? cwd : resolveWorkspaceRoot(cwd);

  const { mode, conversationId } = resolveRescueMode(options);
  const resolved = await resolveRescuePromptAndTitle(parsed, cwd, conversationId, Boolean(options.json));
  if (!resolved.ok) return 1;
  const { userPrompt, title } = resolved;

  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);
  const prompt = buildRescuePrompt(userPrompt || "(continue)");
  if (options.preview) return reportRunPreview({ kind: "rescue", prompt, options, addDirs, extraArgs });
  const selection = await resolveRequestModel({ modelOption: options.model, aliasOption: options["model-alias"],
    effort: options.effort, workspaceRoot, kind: "rescue", mode, conversationId });
  if (!selection.ok) return reportModelResolutionFailure("rescue", selection, options.json);
  const model = selection.model;
  const modelRequest = selection.request;
  const effort = resolveRequestEffort(options.effort, model);

  const probed = await probeAgyForVerb("rescue");
  if (probed.line) return reportAgyUnavailable("rescue", probed.line, options.json);
  await rememberAgyVersion(workspaceRoot, probed.version);

  const runArgs = { workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, modelRequest, effort, agyVersion: probed.version };

  if (options.background) {
    return runRescueBackground({ ...runArgs, options, ctx });
  }

  return runRescueForeground({ ...runArgs, json: options.json });
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runIfMain(import.meta.url, run);

async function resolveRescuePromptAndTitle({ options, positionals }, cwd, conversationId, json) {
  const source = await resolvePromptFileSource(options, cwd);
  if (source) {
    if (!source.ok) {
      process.stderr.write('antigravity:rescue — ' + source.message + '\n');
      outputCommandResult(createErrorEnvelope('rescue', { status: 'invalid_input',
        error: { code: source.code, phase: 'validate', message: source.message } }), '', json);
      return { ok: false };
    }
    return { ok: true, userPrompt: source.text, title: titleFromPromptText(source.text) };
  }
  const userPrompt = positionals.join(' ').trim();
  if (!userPrompt && !options.resume && !options.continue && !options.conversation) {
    reportMissingTaskText('rescue', json);
    return { ok: false };
  }
  return { ok: true, userPrompt, title: userPrompt ? truncate(userPrompt, 80) : 'resume ' + (conversationId ?? 'last') };
}
