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
 *   --effort <low|medium|high|agy-default>  agy reasoning effort for this run
 *                         (default: medium when absent, plan 086 T2;
 *                         agy-default sends no --effort flag at all, so the
 *                         user's own agy configuration decides, plan 086 T5i)
 *   --json                emit JSON instead of markdown
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildRescuePrompt } from "../lib/prompt-templates.mjs";
import {
  AGY_MODES,
  DEFAULT_AGY_EFFORT,
  EFFORT_CHOICES,
  agyModeArgs,
  agyUnavailableLine,
  reportQueuedJob,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  waitAndExit,
  waitForJob,
} from "../lib/job-helpers.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

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

async function runRescueForeground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, effort, json }) {
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
    request: { mode: retryConversationId ? "conversation" : mode, addDirs, model, effort },
    onText: (delta) => process.stderr.write(delta),
  });

  return runForegroundWithRetryPrompt("rescue", runOnce, { json });
}

async function runRescueBackground({ workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, effort, options, ctx }) {
  const { job } = await (ctx.startBackgroundJob ?? startBackgroundJob)({
    workspaceRoot,
    kind: "rescue",
    title,
    prompt,
    mode,
    conversationId,
    addDirs,
    extraArgs,
    cwd: workspaceRoot,
    request: { mode, addDirs, model, effort },
  });
  const queuedExit = reportQueuedJob("rescue", job, options);
  if (queuedExit !== null) return queuedExit;
  if (!options.wait) return 0;
  return waitAndExit("rescue", workspaceRoot, job.id, ctx.waitForJob ?? waitForJob);
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (a prompt and flags)
 * @param {{ cwd?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["conversation", "model", "cwd", "add-dir", "mode", "effort"],
    booleanOptions: ["background", "wait", "resume", "continue", "fresh", "json"],
    repeatableOptions: ["add-dir"],
    valueChoices: { mode: AGY_MODES, effort: EFFORT_CHOICES },
    conflicts: [
      ["continue", "conversation"],
      ["resume", "conversation"],
      ["fresh", "resume"],
      ["fresh", "continue"],
      ["fresh", "conversation"],
    ],
  }, "rescue");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.resume && !options.continue && !options.conversation) {
    process.stderr.write("antigravity:rescue — no task text provided. Pass a prompt or --conversation <id>.\n");
    return 1;
  }

  const { mode, conversationId } = resolveRescueMode(options);

  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);
  const model = options.model ? String(options.model) : undefined;
  const effort = options.effort ? String(options.effort) : DEFAULT_AGY_EFFORT;

  const prompt = buildRescuePrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  const unavailable = await agyUnavailableLine("rescue");
  if (unavailable) {
    process.stderr.write(`${unavailable}\n`);
    return 1;
  }

  const runArgs = { workspaceRoot, title, prompt, mode, conversationId, addDirs, extraArgs, model, effort };

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
