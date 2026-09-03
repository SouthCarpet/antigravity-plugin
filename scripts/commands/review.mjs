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
 */

import { readCommandInput } from "../lib/args.mjs";
import { collectReviewContext } from "../lib/git.mjs";
import { buildReviewPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  agyUnavailableLine,
  foregroundFailureLine,
  runForegroundJob,
  startBackgroundJob,
  waitForJob,
} from "../lib/job-helpers.mjs";
import { createJsonEnvelope, outputCommandResult, reportWarnings, warningDetails } from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

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

  const unavailable = await agyUnavailableLine("review");
  if (unavailable) {
    process.stderr.write(`${unavailable}\n`);
    return 1;
  }

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

  const prompt = buildReviewPrompt(envelope);
  const mode = options.conversation
    ? "conversation"
    : options.continue
    ? "continue"
    : "print";
  const conversationId = options.conversation ? String(options.conversation) : undefined;
  const title = `review: ${envelope.scope}${base ? ` vs ${base}` : ""}`;

  if (options.background) {
    const { job } = await startBackgroundJob({
      workspaceRoot,
      kind: "review",
      title,
      prompt,
      mode,
      conversationId,
      cwd: workspaceRoot,
      request: { scope: envelope.scope, base: base ?? null, mode },
    });
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
      const final = await waitForJob(workspaceRoot, job.id);
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

  if (result.status === "auth_required") {
    process.stderr.write(
      `\nantigravity:review — Antigravity is not authenticated.\n` +
        `Run /antigravity:setup to complete the OAuth flow, then retry.\n`,
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\n${foregroundFailureLine("review", result)}\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  reportWarnings("review", result);
  const payload = createJsonEnvelope("review", {
    status: "completed",
    jobId: job.id,
    answer: result.stdout,
    details: { scope: envelope.scope, ...warningDetails(result) },
  });
  outputCommandResult(payload, result.stdout, Boolean(options.json));
  return 0;
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
