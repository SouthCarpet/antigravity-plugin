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

import { readCommandInput } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildTaskPrompt } from "../lib/prompt-templates.mjs";
import {
  AGY_MODES,
  agyModeArgs,
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

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.continue && !options.conversation) {
    process.stderr.write("antigravity:task — no task text provided. Pass a prompt or --conversation <id>.\n");
    return 1;
  }

  let mode = "print";
  let conversationId;
  if (options.conversation) {
    mode = "conversation";
    conversationId = String(options.conversation);
  } else if (options.continue) {
    mode = "continue";
  }

  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);

  const prompt = buildTaskPrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  const unavailable = await agyUnavailableLine("task");
  if (unavailable) {
    process.stderr.write(`${unavailable}\n`);
    return 1;
  }

  if (options.foreground) {
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

    return finishForeground("task", job, result, { json: options.json });
  }

  // Background path (default).
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
  if (job.status === "failed") {
    process.stderr.write(`${foregroundFailureLine("task", { spawnError: job.errorMessage })}\n`);
    return 1;
  }
  const payload = createJsonEnvelope("task", {
    status: "queued",
    jobId: job.id,
    details: {
      message: `Background task started. Run /antigravity:status ${job.id} to check progress.`,
    },
  });
  outputCommandResult(
    payload,
    `Background task started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
    Boolean(options.json),
  );

  if (options.wait) {
    const final = await wait(workspaceRoot, job.id);
    const line = waitOutcomeLine("task", final);
    if (line) process.stderr.write(`${line}\n`);
    if (!final) return 1;
    if (!options.json && final.status === "completed" && final.result?.rawOutput) {
      process.stdout.write(final.result.rawOutput);
    }
    return final.status === "completed" ? 0 : final.status === "cancelled" ? 2 : 1;
  }
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runIfMain(import.meta.url, run);
