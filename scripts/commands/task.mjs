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
 *   --json                emit JSON
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildTaskPrompt } from "../lib/prompt-templates.mjs";
import {
  AGY_MODES,
  agyModeArgs,
  agyUnavailableLine,
  exitCodeForJobStatus,
  finishForeground,
  reportQueuedJob,
  runForegroundJob,
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

async function runTaskForeground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, json }) {
  const { job, result } = await runForegroundJob({
    workspaceRoot,
    kind: "task",
    title,
    prompt,
    mode,
    conversationId,
    addDirs,
    extraArgs,
    cwd: workspaceRoot,
    request: { prompt, mode, addDirs },
    onText: (delta) => process.stderr.write(delta),
  });

  return finishForeground("task", job, result, { json });
}

async function runTaskBackground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, options, ctx }) {
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
    request: { mode, addDirs },
  });
  const queuedExit = reportQueuedJob("task", job, options);
  if (queuedExit !== null) return queuedExit;

  if (!options.wait) return 0;
  const final = await wait(workspaceRoot, job.id);
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
    valueOptions: ["conversation", "cwd", "add-dir", "mode"],
    booleanOptions: ["wait", "foreground", "background", "continue", "json"],
    repeatableOptions: ["add-dir"],
    valueChoices: { mode: AGY_MODES },
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
    process.stderr.write("antigravity:task — no task text provided. Pass a prompt or --conversation <id>.\n");
    return 1;
  }

  const { mode, conversationId } = resolveTaskMode(options);
  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);

  const prompt = buildTaskPrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  const unavailable = await agyUnavailableLine("task");
  if (unavailable) {
    process.stderr.write(`${unavailable}\n`);
    return 1;
  }

  const runArgs = { workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs };

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
