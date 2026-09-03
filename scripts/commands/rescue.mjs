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
 *   --model <id>          accepted for forward-compat, currently logged + ignored
 *   --json                emit JSON instead of markdown
 */

import { readCommandInput } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { buildRescuePrompt } from "../lib/prompt-templates.mjs";
import {
  AGY_MODES,
  agyModeArgs,
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
    valueOptions: ["conversation", "model", "cwd", "add-dir", "mode"],
    booleanOptions: ["background", "wait", "resume", "continue", "fresh", "json"],
    repeatableOptions: ["add-dir"],
    valueChoices: { mode: AGY_MODES },
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

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const userPrompt = positionals.join(" ").trim();
  if (!userPrompt && !options.resume && !options.continue && !options.conversation) {
    process.stderr.write("antigravity:rescue — no task text provided. Pass a prompt or --conversation <id>.\n");
    return 1;
  }

  if (options.model) {
    process.stderr.write(
      `antigravity:rescue — note: --model is accepted for forward-compatibility but ` +
        `agy 1.0.1 does not expose a per-invocation model flag yet. Ignoring "${options.model}".\n`,
    );
  }

  // Resolve conversation mode. --conversation wins; then --resume/--continue; then fresh.
  let mode = "print";
  let conversationId;
  if (options.conversation) {
    mode = "conversation";
    conversationId = String(options.conversation);
  } else if ((options.resume || options.continue) && !options.fresh) {
    mode = "continue";
  }

  const addDirs = options["add-dir"] ? options["add-dir"].map(String) : [];
  const extraArgs = agyModeArgs(options.mode);

  const prompt = buildRescuePrompt(userPrompt || "(continue)");
  const title = userPrompt ? truncate(userPrompt, 80) : `resume ${conversationId ?? "last"}`;

  const unavailable = await agyUnavailableLine("rescue");
  if (unavailable) {
    process.stderr.write(`${unavailable}\n`);
    return 1;
  }

  if (options.background) {
    const { job } = await startBackgroundJob({
      workspaceRoot,
      kind: "rescue",
      title,
      prompt,
      mode,
      conversationId,
      addDirs,
      extraArgs,
      cwd: workspaceRoot,
      request: { mode, addDirs },
    });
    const payload = createJsonEnvelope("rescue", {
      status: "queued",
      jobId: job.id,
      details: {
        message: `Background rescue started. Run /antigravity:status ${job.id} to check progress.`,
      },
    });
    outputCommandResult(
      payload,
      `Background rescue started: ${job.id}\nRun /antigravity:status ${job.id} to check progress.\n`,
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
    kind: "rescue",
    title,
    prompt,
    mode,
    conversationId,
    addDirs,
    extraArgs,
    cwd: workspaceRoot,
    request: { mode, addDirs },
    onText: (delta) => process.stderr.write(delta),
  });

  if (result.status === "auth_required") {
    process.stderr.write(
      `\nantigravity:rescue — Antigravity is not authenticated. Run /antigravity:setup, then retry.\n`,
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\n${foregroundFailureLine("rescue", result)}\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  reportWarnings("rescue", result);
  outputCommandResult(
    createJsonEnvelope("rescue", {
      status: "completed",
      jobId: job.id,
      answer: result.stdout,
      details: warningDetails(result),
    }),
    result.stdout,
    Boolean(options.json),
  );
  return 0;
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export default run;

runIfMain(import.meta.url, run);
