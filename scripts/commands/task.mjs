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
 *   --json                emit JSON
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildTaskPrompt } from "../lib/prompt-templates.mjs";
import {
  AGY_MODES,
  EFFORT_CHOICES,
  agyModeArgs,
  exitCodeForJobStatus,
  printMeasuredUsageTrailer,
  probeAgyForVerb,
  reportAgyUnavailable,
  reportMissingTaskText,
  reportQueuedJob,
  resolveRequestEffort,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  waitForJob,
  waitOutcomeLine,
} from "../lib/job-helpers.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

/**
 * @param {{ conversation?: string, continue?: boolean }} options
 * @returns {{ mode: string, conversationId: string | undefined }}
 */
function resolveTaskMode(options) {
  if (options.conversation) return { mode: "conversation", conversationId: String(options.conversation) };
  if (options.continue) return { mode: "continue", conversationId: undefined };
  return { mode: "print", conversationId: undefined };
}

/**
 * Print the finished job's raw output on stdout when `--wait` completed
 * without `--json` — the one behaviour `task --wait` has that `rescue`/
 * `review`'s wait tail does not.
 *
 * @param {import('../lib/types.mjs').JobRecord} final
 * @param {boolean} json
 * @returns {void}
 */
function printCompletedRawOutput(final, json) {
  if (json || final.status !== "completed" || !final.result?.rawOutput) return;
  process.stdout.write(final.result.rawOutput);
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
  const { job } = await start({
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
  });
  const queuedExit = reportQueuedJob("task", job, options);
  if (queuedExit !== null) return queuedExit;

  if (!options.wait) return 0;
  const final = await wait(workspaceRoot, job.id);
  if (final?.status === "completed") printMeasuredUsageTrailer(final.result?.usage ?? null);
  const line = waitOutcomeLine("task", final);
  if (line) process.stderr.write(`${line}\n`);
  if (!final) return 1;
  printCompletedRawOutput(final, options.json);
  return exitCodeForJobStatus(final.status);
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a prompt and flags)
 * @param {{ cwd?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["conversation", "cwd", "add-dir", "mode", "model", "effort"],
    booleanOptions: ["wait", "foreground", "background", "continue", "json"],
    repeatableOptions: ["add-dir"],
    valueChoices: { mode: AGY_MODES, effort: EFFORT_CHOICES },
    conflicts: [
      ["foreground", "background"],
      ["continue", "conversation"],
    ],
  }, "task");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.continue && !options.conversation) {
    return reportMissingTaskText("task", Boolean(options.json));
  }

  const { mode, conversationId } = resolveTaskMode(options);
  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);
  const model = options.model ? String(options.model) : undefined;
  const effort = resolveRequestEffort(options.effort, model);

  const prompt = buildTaskPrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  const probed = await probeAgyForVerb("task");
  if (probed.line) return reportAgyUnavailable("task", probed.line, options.json);

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
