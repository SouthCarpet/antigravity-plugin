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
 * an image content block, so this prompt instructs the model to call the
 * `view_image` MCP tool for every listed path, and forbids `read_file` on
 * an image: that returns bytes as text, which is exactly the failure mode
 * the `VISION-UNAVAILABLE` sentinel exists for.
 *
 * The answer has a fixed shape, transcription first. A model that must
 * copy every visible string verbatim before it interprets anything cannot
 * describe UI that is not there without the transcript contradicting it,
 * and the transcript can be checked against the source by a human or a
 * test. Plan 065 (2026-09) recorded a PASS-on-every-axis review of elements
 * that did not exist; the transcription-first instruction was the fix that
 * held.
 *
 * @param {{ imagePaths: string[], userPrompt: string }} args
 * @returns {string}
 */
export function buildVisionPrompt({ imagePaths, userPrompt }) {
  const lines = [];
  lines.push("You have an MCP tool named `view_image` that loads an image file from disk");
  lines.push("and returns it as real visual image content you can see.");
  lines.push("");
  lines.push("`view_image` is the ONLY way to see an image. Do NOT call `read_file` (or any");
  lines.push("other file tool) on an image path: it returns bytes as text, not pixels, and");
  lines.push("you would be guessing.");
  lines.push("");
  lines.push(`Call \`view_image\` once for EACH of the following ${imagePaths.length} image path(s), in order:`);
  for (const p of imagePaths) {
    lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("When you can see every image, reply with EXACTLY these three sections, in this");
  lines.push("order, and nothing before the first heading:");
  lines.push("");
  lines.push("## Transcription");
  lines.push("For each image, in the order listed, a sub-heading `### Image N: <file name>`");
  lines.push("followed by EVERY visible text string, verbatim, one per line: labels, headings,");
  lines.push("buttons, menu items, table cells, numbers, units, currency symbols, placeholders,");
  lines.push("captions. Copy exactly what is rendered, including case, spacing, punctuation and");
  lines.push("diacritics. No paraphrase, no omission, no grouping, no interpretation. If an image");
  lines.push("has no text, write `(no text)` under its sub-heading.");
  lines.push("");
  lines.push("## Observations");
  lines.push("Concrete visual facts only, one per line: layout, regions, colours, shapes, states");
  lines.push("(selected, disabled, error), alignment, anything unusual. Describe only what is");
  lines.push("visible. Do not name elements that do not appear in the transcription above unless");
  lines.push("they carry no text (icons, images, borders).");
  lines.push("");
  lines.push("## Answer");
  lines.push("Answer the question below using ONLY the two sections above. Where the question");
  lines.push("asks about text or values, quote the transcribed line.");
  lines.push("");
  lines.push("## Question");
  lines.push(userPrompt);
  lines.push("");
  lines.push("## Contract");
  lines.push(
    "If `view_image` is unavailable, errors, or returns no actual visual content for any path, " +
      "do NOT guess, do NOT fall back to another tool, and do NOT answer from the file path/name. " +
      "Instead reply with EXACTLY one line, no other text:",
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
