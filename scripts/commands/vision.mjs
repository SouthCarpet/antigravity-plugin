/**
 * /antigravity:vision — ask Antigravity (agy) to look at one or more images.
 *
 * `agy --print` has no native image ingestion path (see
 * scripts/mcp/vision-server.mjs for the full story). This verb only produces
 * real visual answers once `/antigravity:setup` has registered the `vision`
 * MCP server + tool permissions in agy's config
 * (~/.gemini/config/mcp_config.json, ~/.gemini/antigravity-cli/settings.json).
 * If that registration is missing, agy still runs — it just cannot see the
 * images, and the prompt contract asks it to say so via the
 * `VISION-UNAVAILABLE: <reason>` sentinel rather than guess.
 *
 * Usage: vision <image-path> [<image-path>...] --prompt "<question>"
 *
 * Flags:
 *   --prompt <text>   question to ask about the image(s); default: generic description
 *   --model <id>      agy model id (default gemini-3.6-flash-high)
 *   --json            output JSON instead of markdown
 *   --cwd <dir>       override working directory
 *
 * FOREGROUND ONLY in this version — no --background/--wait. See vision.md.
 */

import { existsSync, statSync } from "node:fs";
import { basename, extname, resolve as resolvePath } from "node:path";

import { ArgsError, readCommandInput } from "../lib/args.mjs";
import { buildVisionPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runForegroundJob } from "../lib/job-helpers.mjs";
import { createJsonEnvelope, outputCommandResult, reportWarnings, warningDetails } from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";
import {
  encodeVisionAllowlist,
  VISION_ALLOWLIST_ENV,
  VISION_EXTENSIONS,
  VISION_MAX_BYTES,
  VISION_MIME,
} from "../lib/vision-capability.mjs";

const DEFAULT_MODEL = "gemini-3.6-flash-high";
const DEFAULT_PROMPT =
  "Describe this image in concrete, specific detail: layout, elements, colors, text, and anything unusual.";

/**
 * The first reason this file cannot reach the model, or null when it can.
 *
 * The MCP server applies the same extension table and the same size cap, but
 * only after agy has started and spent tokens, and its refusal comes back as
 * an answer-shaped reply. Checking here fails before any spawn.
 *
 * @param {string} imagePath - absolute path
 * @returns {string|null}
 */
function imageProblem(imagePath) {
  if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
    return `image file not found: ${imagePath}`;
  }
  const ext = extname(imagePath).toLowerCase();
  if (!VISION_MIME[ext]) {
    return (
      `unsupported image extension "${ext || "(none)"}": ${imagePath}. ` +
      `Supported: ${VISION_EXTENSIONS.join(", ")}`
    );
  }
  const { size } = statSync(imagePath);
  if (size > VISION_MAX_BYTES) {
    return `image too large (${size} bytes > ${VISION_MAX_BYTES} byte cap): ${imagePath}`;
  }
  return null;
}

export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["prompt", "model", "cwd"],
    booleanOptions: ["json"],
  }, "vision");
  if (!parsed) return 1;
  const { options, positionals } = parsed;

  // `parseArgs` keeps unknown options on purpose (see args.mjs), so a caller
  // passing --add-dir would otherwise sail through silently: it is not
  // forwarded to agy, but the run would proceed as if extra read access had
  // been granted. vision has no --add-dir contract (docs/COMPATIBILITY.md).
  // Reject it here, before image validation and before any spawn.
  if (options["add-dir"] !== undefined) {
    const err = new ArgsError(
      "vision does not take --add-dir; the images named on the command line are the only files the model may see.",
    );
    process.stderr.write(`antigravity:vision — ${err.message}\n`);
    return 1;
  }

  const cwd = options.cwd ? String(options.cwd) : ctx.cwd ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  if (positionals.length === 0) {
    process.stderr.write(
      'antigravity:vision — no image path provided. Usage: vision <image-path> [<image-path>...] --prompt "<question>"\n',
    );
    return 1;
  }

  // Resolve to absolute paths up front: agy (and the vision-server it spawns
  // as an MCP subprocess) runs with cwd=workspaceRoot, which may differ from
  // the caller's cwd. Absolute paths sidestep that mismatch entirely.
  const imagePaths = positionals.map((p) => resolvePath(cwd, String(p)));
  for (const imagePath of imagePaths) {
    const problem = imageProblem(imagePath);
    if (problem) {
      process.stderr.write(`antigravity:vision — ${problem}\n`);
      return 1;
    }
  }

  const userPrompt = options.prompt ? String(options.prompt) : DEFAULT_PROMPT;
  const model = options.model ? String(options.model) : DEFAULT_MODEL;
  const prompt = buildVisionPrompt({ imagePaths, userPrompt });
  const title = `vision: ${imagePaths.map((p) => basename(p)).join(", ")}`;
  const env = {
    ...process.env,
    [VISION_ALLOWLIST_ENV]: encodeVisionAllowlist(imagePaths),
  };

  const { job, result } = await runForegroundJob({
    workspaceRoot,
    kind: "vision",
    title,
    prompt,
    mode: "print",
    model,
    outputFormat: "json",
    cwd: workspaceRoot,
    env,
    request: { imagePaths, model, userPrompt },
    onText: (delta) => process.stderr.write(delta),
  });

  if (result.status === "auth_required") {
    process.stderr.write(
      `\nantigravity:vision — Antigravity is not authenticated.\n` +
        `Run /antigravity:setup to complete the OAuth flow, then retry.\n`,
    );
    if (result.oauthUrl) process.stderr.write(`OAuth URL: ${result.oauthUrl}\n`);
    return 1;
  }
  if (result.status !== "completed") {
    process.stderr.write(`\nantigravity:vision — failed (${result.status}).\n`);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status === "cancelled" ? 2 : 1;
  }

  reportWarnings("vision", result);
  const usage = result.usage ?? null;
  if (usage && typeof usage.total_tokens === "number") {
    // Measured by agy itself (json envelope). The ledger rule requires
    // recording measured totals — this trailer is what the orchestrator reads.
    process.stderr.write(
      `usage: total=${usage.total_tokens} in=${usage.input_tokens ?? "?"} ` +
        `out=${usage.output_tokens ?? "?"}\n`,
    );
  }

  const payload = createJsonEnvelope("vision", {
    status: "completed",
    jobId: job.id,
    answer: result.stdout,
    imagePaths,
    model,
    details: {
      usage,
      durationSeconds: result.durationSeconds ?? null,
      ...warningDetails(result),
    },
  });
  outputCommandResult(payload, result.stdout, Boolean(options.json));
  return 0;
}

export default run;

runIfMain(import.meta.url, run);
