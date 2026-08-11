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
import { basename, resolve as resolvePath } from "node:path";

import { parseCommandInput } from "../lib/args.mjs";
import { buildVisionPrompt } from "../lib/prompt-templates.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { runForegroundJob } from "../lib/job-helpers.mjs";
import { outputCommandResult } from "../lib/render.mjs";

const DEFAULT_MODEL = "gemini-3.6-flash-high";
const DEFAULT_PROMPT =
  "Describe this image in concrete, specific detail: layout, elements, colors, text, and anything unusual.";

export async function run(argv = [], ctx = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["prompt", "model", "cwd"],
    booleanOptions: ["json"],
  });

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
    if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
      process.stderr.write(`antigravity:vision — image file not found: ${imagePath}\n`);
      return 1;
    }
  }

  const userPrompt = options.prompt ? String(options.prompt) : DEFAULT_PROMPT;
  const model = options.model ? String(options.model) : DEFAULT_MODEL;
  const prompt = buildVisionPrompt({ imagePaths, userPrompt });
  const title = `vision: ${imagePaths.map((p) => basename(p)).join(", ")}`;

  const { result } = await runForegroundJob({
    workspaceRoot,
    kind: "vision",
    title,
    prompt,
    mode: "print",
    model,
    outputFormat: "json",
    cwd: workspaceRoot,
    request: { imagePaths, model, userPrompt },
    onStdout: (chunk) => process.stderr.write(chunk),
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

  const usage = result.usage ?? null;
  if (usage && typeof usage.total_tokens === "number") {
    // Measured by agy itself (json envelope). The ledger rule requires
    // recording measured totals — this trailer is what the orchestrator reads.
    process.stderr.write(
      `usage: total=${usage.total_tokens} in=${usage.input_tokens ?? "?"} ` +
        `out=${usage.output_tokens ?? "?"}\n`,
    );
  }

  const payload = {
    imagePaths,
    model,
    vision: result.stdout,
    usage,
    durationSeconds: result.durationSeconds ?? null,
  };
  outputCommandResult(payload, result.stdout, Boolean(options.json));
  return 0;
}

export default run;
