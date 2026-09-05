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

import { readCommandInput } from "../lib/args.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildReviewPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  agyUnavailableLine,
  finishForeground,
  foregroundFailureLine,
  runForegroundJob,
  startBackgroundJob,
  waitForJob,
  waitOutcomeLine,
} from "../lib/job-helpers.mjs";
import { createJsonEnvelope, outputCommandResult } from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

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

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
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
  const mode = options.conversation
    ? "conversation"
    : options.continue
    ? "continue"
    : "print";
  const conversationId = options.conversation ? String(options.conversation) : undefined;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}`;

  if (options.background) {
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
    if (job.status === "failed") {
      process.stderr.write(`${foregroundFailureLine("review", { spawnError: job.errorMessage })}\n`);
      return 1;
    }
    const payload = createJsonEnvelope("review", {
      status: "queued",
      jobId: job.id,
      details: {
        message: `Background review started. Run /antigravity:status ${job.id} to check progress.`,
      },
    });
    outputCommandResult(
      payload,
      `Background review started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
      Boolean(options.json),
    );
    if (options.wait) {
      const final = await (ctx.waitForJob ?? waitForJob)(workspaceRoot, job.id);
      const line = waitOutcomeLine("review", final);
      if (line) process.stderr.write(`${line}\n`);
      return final?.status === "completed" ? 0 : final?.status === "cancelled" ? 2 : 1;
    }
    return 0;
  }

  const { job, result } = await runForegroundJob({
    workspaceRoot,
    kind: "review",
    title,
    prompt,
    mode,
    conversationId,
    cwd: workspaceRoot,
    request: { scope: envelope.scope, base: base ?? null, mode },
    onText: (delta) => process.stderr.write(delta),
  });

  return finishForeground("review", job, result, {
    json: options.json,
    extraDetails: { scope: envelope.scope },
  });
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
