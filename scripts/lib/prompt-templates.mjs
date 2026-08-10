/**
 * Inline prompt templates for the antigravity-plugin commands.
 *
 * Kept inline (rather than in disk-loaded /prompts files) for v0.1.0 so the
 * plugin remains self-contained and so the templates can grow function-style
 * helpers without an extra interpolation layer.
 *
 * agy 1.0.1 has no ACP, no streaming, no structured-output schema. Every
 * template here is plain natural language that produces a textual response.
 */

const MAX_DIFF_BYTES = 196 * 1024;

function trimDiff(diff) {
  if (typeof diff !== "string" || diff.length <= MAX_DIFF_BYTES) return diff ?? "";
  const head = diff.slice(0, MAX_DIFF_BYTES);
  const dropped = diff.length - MAX_DIFF_BYTES;
  return `${head}\n\n[... ${dropped} more diff bytes truncated for prompt size ...]`;
}

/**
 * Build the review prompt for `/antigravity:review`.
 *
 * @param {{ scope: string, context: any }} contextEnvelope - Return value from collectReviewContext.
 * @returns {string}
 */
export function buildReviewPrompt(contextEnvelope) {
  const { scope, context } = contextEnvelope;
  const lines = [];
  lines.push("You are reviewing a code change. Your output is read-only.");
  lines.push("Do NOT propose tool calls, do NOT modify files, do NOT ask follow-ups.");
  lines.push("");
  lines.push(`Scope: ${scope}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(context.summary ?? "(no summary)");
  lines.push("");

  if (scope === "branch") {
    lines.push("## Commits");
    lines.push("```");
    lines.push((context.commits ?? "").trim() || "(no commits)");
    lines.push("```");
    lines.push("");
  }

  lines.push("## Diff");
  lines.push("```diff");
  lines.push(trimDiff(context.diff));
  lines.push("```");

  if (scope !== "branch" && context.untrackedContents && context.untrackedContents.length > 0) {
    lines.push("");
    lines.push("## Untracked files (first 24 KB each)");
    for (const file of context.untrackedContents) {
      lines.push("");
      lines.push(`### ${file.path}`);
      lines.push("```");
      lines.push(file.content ?? "(binary or unreadable)");
      lines.push("```");
    }
  }

  lines.push("");
  lines.push("## Output");
  lines.push("Produce a Markdown review with the following sections:");
  lines.push("- **Verdict** (one line: APPROVE | CHANGES REQUESTED | NEEDS DISCUSSION)");
  lines.push("- **Summary** (2-3 sentences on overall change quality)");
  lines.push("- **Findings** (bulleted; for each include severity [critical|high|medium|low|nit], file:line, description, recommendation)");
  lines.push("- **Next Steps** (bulleted; concrete actions for the author)");
  lines.push("");
  lines.push("Be concise. Skip findings if the change is trivial. Do not suggest follow-up tool calls.");
  return lines.join("\n");
}

/**
 * Build the vision prompt for `/antigravity:vision`.
 *
 * agy `--print` has no native image ingestion path (see vision-server.mjs
 * header). The only proven channel is an MCP tool call whose result carries
 * an image content block, so this prompt explicitly instructs the model to
 * call the `view_image` MCP tool for every listed path before answering.
 *
 * @param {{ imagePaths: string[], userPrompt: string }} args
 * @returns {string}
 */
export function buildVisionPrompt({ imagePaths, userPrompt }) {
  const lines = [];
  lines.push("You have an MCP tool named `view_image` that loads an image file from disk");
  lines.push("and returns it as real visual image content you can see.");
  lines.push("");
  lines.push(`Call \`view_image\` once for EACH of the following ${imagePaths.length} image path(s), in order:`);
  for (const p of imagePaths) {
    lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("After you have called the tool for every path above and can see the returned images,");
  lines.push("answer the following question with concrete visual observations only — describe what");
  lines.push("you actually see (layout, elements, colors, text, anything unusual). Do not guess or");
  lines.push("infer content you have not seen.");
  lines.push("");
  lines.push("## Question");
  lines.push(userPrompt);
  lines.push("");
  lines.push("## Contract");
  lines.push(
    "If any `view_image` call returns no actual visual content, errors, or the tool is unavailable, " +
      "do NOT guess or answer from the file path/name alone. Instead reply with EXACTLY one line, " +
      "no other text:",
  );
  lines.push("VISION-UNAVAILABLE: <one-line reason>");
  return lines.join("\n");
}

/**
 * Build the rescue prompt — passes the user prompt through verbatim with a
 * lightweight system preamble. agy already has its own system prompt; we add
 * just enough to set the tone.
 *
 * @param {string} userPrompt
 * @returns {string}
 */
export function buildRescuePrompt(userPrompt) {
  return userPrompt;
}

/**
 * Build the task prompt. Same shape as rescue — agy handles the rest.
 *
 * @param {string} userPrompt
 * @returns {string}
 */
export function buildTaskPrompt(userPrompt) {
  return userPrompt;
}
