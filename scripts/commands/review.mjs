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
 *   --json            output JSON instead of markdown
 *
 * The diff is collected first. An empty one answers `no_changes` with exit 0
 * from Git alone, so a machine without `agy` can still run this. `agy` is
 * probed only when there is content to send, before the prompt, the job
 * record and any spawn.
 */

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildReviewPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  agyUnavailableLine,
  reportQueuedJob,
  runForegroundJob,
  runForegroundWithRetryPrompt,
  startBackgroundJob,
  waitAndExit,
  waitForJob,
} from "../lib/job-helpers.mjs";
import { createJsonEnvelope, outputCommandResult } from "../lib/render.mjs";
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

async function runReviewBackground({ workspaceRoot, title, prompt, mode, conversationId, envelope, base, options, ctx }) {
  const { job } = await (ctx.startBackgroundJob ?? startBackgroundJob)({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode,
    conversationId,
    cwd: workspaceRoot,
    request: { scope: envelope.scope, base: base ?? null, mode },
  });
  const queuedExit = reportQueuedJob("review", job, options);
  if (queuedExit !== null) return queuedExit;
  if (!options.wait) return 0;
  return waitAndExit("review", workspaceRoot, job.id, ctx.waitForJob ?? waitForJob);
}

async function runReviewForeground({ workspaceRoot, title, prompt, mode, conversationId, envelope, base, json }) {
  const runOnce = (retryConversationId) => runForegroundJob({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode: retryConversationId ? "conversation" : mode,
    conversationId: retryConversationId ?? conversationId,
    cwd: workspaceRoot,
    request: { scope: envelope.scope, base: base ?? null, mode: retryConversationId ? "conversation" : mode },
    onText: (delta) => process.stderr.write(delta),
  });

  return runForegroundWithRetryPrompt("review", runOnce, {
    json,
    extraDetails: { scope: envelope.scope },
  });
}

/**
 * @param {string[]} [argv] CLI arguments after the verb (flags only)
 * @param {{ cwd?: string, startBackgroundJob?: typeof startBackgroundJob,
 *   waitForJob?: typeof waitForJob }} [ctx] dependency overrides for tests, plus `cwd`
 * @returns {Promise<number>} process exit code
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["base", "scope", "conversation", "cwd"],
    booleanOptions: ["background", "wait", "continue", "json"],
    conflicts: [
      ["continue", "conversation"],
    ],
  }, "review");
  if (!parsed) return 1;
  const { options } = parsed;

  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const scope = (options.scope ? String(options.scope) : "auto");
  const base = options.base ? String(options.base) : undefined;

  let envelope;
  try {
    envelope = collectReviewContext(workspaceRoot, { scope, base });
  } catch (err) {
    process.stderr.write(`antigravity:review — ${err?.message ?? err}\n`);
    return 1;
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

  const unavailable = await agyUnavailableLine("review");
  if (unavailable) {
    process.stderr.write(`${unavailable}\n`);
    return 1;
  }

  const prompt = buildReviewPrompt(envelope);
  const mode = resolveReviewMode(options);
  const conversationId = options.conversation ? String(options.conversation) : undefined;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}`;

  const runArgs = { workspaceRoot, title, prompt, mode, conversationId, envelope, base };

  if (options.background) {
    return runReviewBackground({ ...runArgs, options, ctx });
  }

  return runReviewForeground({ ...runArgs, json: options.json });
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
