/**
 * buildReviewInput — the single selection function for `/antigravity:review`
 * (Task 5, "Senate R5", 2026-09): foreground, background, and `--preview`
 * all call this one function to decide exactly what content reaches agy,
 * what got left out and why, whether the diff was cut, and the hash of the
 * exact prompt string that would be sent.
 *
 * Kept in its own module rather than folded into `prompt-templates.mjs`
 * (223 lines, three prompt-TEXT builders already): input SELECTION — what
 * to include, what to skip, what to hash — is a distinct responsibility
 * from prompt wording, and `prompt-templates.mjs` would cross 350 lines
 * with both in one file.
 */

import { createHash } from "node:crypto";

import { buildReviewPrompt, diffTruncationInfo } from "./prompt-templates.mjs";

/**
 * @param {...string[]} groups
 * @returns {string[]} deduplicated, sorted union of every group
 */
function uniquePaths(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

/** Splits a `git diff` string right before each file's own `diff --git ` header. */
const DIFF_HEADER_SPLIT_RE = /(?=^diff --git )/m;

/**
 * The path named by one file's diff chunk: the `+++ b/<path>` line when
 * present (an add or a modify), else `--- a/<path>` (a pure delete has no
 * `+++ b/` line), else the `diff --git a/X b/Y` header itself. `null` only
 * for a chunk with none of the three — never invented.
 *
 * @param {string} chunk
 * @returns {string | null}
 */
function diffChunkPath(chunk) {
  const plusMatch = chunk.match(/^\+\+\+ b\/(.+)$/m);
  if (plusMatch) return plusMatch[1].trim();
  const minusMatch = chunk.match(/^--- a\/(.+)$/m);
  if (minusMatch) return minusMatch[1].trim();
  const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (!headerMatch) return null;
  return headerMatch[2] || headerMatch[1];
}

/**
 * The file-name list a scope's `context` already carries, for the (unusual)
 * case where `diff` has no `diff --git` boundary to split on at all — real
 * `git diff` output always has one per file, so this only matters for a
 * hand-built envelope.
 *
 * @param {string} scope
 * @param {any} context
 * @returns {string[]}
 */
function diffFallbackPaths(scope, context) {
  if (scope === "branch") return context.fileList ?? [];
  return uniquePaths(context.files?.staged ?? [], context.files?.unstaged ?? []);
}

/**
 * `included` entries of `kind: "diff"`: one per file the diff itself names,
 * each with the real byte length of that file's own diff section. Falls
 * back to `fallbackPaths` with `bytes: null` only when the diff carries no
 * `diff --git` boundary at all.
 *
 * @param {string} diff
 * @param {string[]} fallbackPaths
 * @returns {Array<{ path: string, kind: "diff", bytes: number | null }>}
 */
function buildDiffEntries(diff, fallbackPaths) {
  const text = typeof diff === "string" ? diff : "";
  const chunks = text.split(DIFF_HEADER_SPLIT_RE).filter((chunk) => chunk.trim() !== "");
  if (chunks.length === 0) {
    return fallbackPaths.map((path) => ({ path, kind: "diff", bytes: null }));
  }
  return chunks.map((chunk) => ({
    path: diffChunkPath(chunk) ?? "(unknown path)",
    kind: "diff",
    bytes: Buffer.byteLength(chunk, "utf8"),
  }));
}

/** Matches one `@@ -a,b +c,d @@` hunk header; a missing count means one line. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

/**
 * The `{ path, newStart, newEnd }` hunks one file's diff chunk adds (Task
 * 14, "Senate R8", 2026-09): one entry per `@@` header, `newStart`/`newEnd`
 * inclusive off that header's `+c,d` side (`d` defaults to 1 when the diff
 * omits the count). A pure-deletion hunk (`d` is `0`, no line actually
 * added) contributes nothing — there is no new-file line for a citation to
 * land on.
 *
 * @param {string} path
 * @param {string} chunk
 * @returns {Array<{ path: string, newStart: number, newEnd: number }>}
 */
function diffChunkHunks(path, chunk) {
  const hunks = [];
  for (const match of chunk.matchAll(HUNK_HEADER_RE)) {
    const newStart = Number(match[1]);
    const newCount = match[2] === undefined ? 1 : Number(match[2]);
    if (newCount === 0) continue;
    hunks.push({ path, newStart, newEnd: newStart + newCount - 1 });
  }
  return hunks;
}

/**
 * Every hunk the sent diff carries, across every file chunk it contains
 * (Task 14, "Senate R8", 2026-09): the same per-file split
 * {@link buildDiffEntries} uses, so a chunk with no resolvable path
 * ({@link diffChunkPath} returning `null`) contributes no hunks rather than
 * one under an invented name.
 *
 * @param {string} diff
 * @returns {Array<{ path: string, newStart: number, newEnd: number }>}
 */
export function parseDiffHunks(diff) {
  const text = typeof diff === "string" ? diff : "";
  const chunks = text.split(DIFF_HEADER_SPLIT_RE).filter((chunk) => chunk.trim() !== "");
  const hunks = [];
  for (const chunk of chunks) {
    const path = diffChunkPath(chunk);
    if (path === null) continue;
    hunks.push(...diffChunkHunks(path, chunk));
  }
  return hunks;
}

/**
 * The number of lines in a whole-file string (Task 14, "Senate R8",
 * 2026-09): a trailing newline never counts as one more empty line, so a
 * normally-terminated file's last real line is still `newEnd`.
 *
 * @param {string} text
 * @returns {number}
 */
function wholeFileLineCount(text) {
  if (text === "") return 0;
  const newlineCount = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}

/**
 * The one hunk per included untracked file, `{ path, newStart: 1, newEnd:
 * <line count> }` (Task 14, "Senate R8", 2026-09) — a whole untracked file
 * is one hunk covering every line it has. Mirrors
 * {@link buildUntrackedEntries}'s own `included` filter (skipped entries
 * carry no content to count), and the same branch scope carries no
 * untracked content at all.
 *
 * @param {string} scope
 * @param {any} context
 * @returns {Array<{ path: string, newStart: 1, newEnd: number }>}
 */
function untrackedHunks(scope, context) {
  if (scope === "branch") return [];
  const hunks = [];
  for (const entry of context.untrackedContents ?? []) {
    if (entry.skipped) continue;
    hunks.push({ path: entry.path, newStart: 1, newEnd: wholeFileLineCount(entry.content ?? "") });
  }
  return hunks;
}

/**
 * `included`/`skipped` untracked entries, straight off `context.untrackedContents`
 * (`readUntrackedFiles`, git.mjs) — `skipped` reasons are that function's own
 * strings, never re-derived here. Branch scope never carries untracked
 * content (`buildReviewPrompt` gates on the same condition), so both lists
 * are empty for it.
 *
 * @param {string} scope
 * @param {any} context
 * @returns {{ included: Array<{ path: string, kind: "untracked", bytes: number }>,
 *   skipped: Array<{ path: string, reason: string }> }}
 */
function buildUntrackedEntries(scope, context) {
  if (scope === "branch") return { included: [], skipped: [] };
  const included = [];
  const skipped = [];
  for (const entry of context.untrackedContents ?? []) {
    if (entry.skipped) {
      skipped.push({ path: entry.path, reason: entry.skipped });
    } else {
      included.push({
        path: entry.path,
        kind: "untracked",
        bytes: Buffer.byteLength(entry.content ?? "", "utf8"),
      });
    }
  }
  return { included, skipped };
}

/**
 * @param {Array<{ bytes: number | null }>} entries
 * @returns {number}
 */
function sumBytes(entries) {
  return entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0);
}

/**
 * @param {string} text
 * @returns {string} `sha256:<hex>`
 */
function sha256Of(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Build the one review-input record every path (foreground, background,
 * `--preview`) selects from and reports on.
 *
 * `envelope` is `collectReviewContext`'s own return value (`git.mjs`):
 * `{ scope, context, base, headSha }`. This function calls
 * {@link buildReviewPrompt}`(envelope, { focus })` itself, so the "## Reviewer
 * focus" section (Task 4) stays exactly where it already is — callers never
 * build the prompt a second time.
 *
 * @param {{ scope: string, context: any, base?: string | null, headSha?: string | null }} envelope
 * @param {{ focus?: string, findingsJson?: boolean }} [options] `findingsJson`
 *   (Senate R7, 2026-09) is passed through to {@link buildReviewPrompt}, so
 *   `--preview` and `inputHash` see the same prompt a run sends.
 * @returns {{
 *   prompt: string,
 *   included: Array<{ path: string, kind: "diff" | "untracked", bytes: number | null }>,
 *   skipped: Array<{ path: string, reason: string }>,
 *   truncated: { diff: boolean, droppedBytes: number },
 *   counts: { includedFiles: number, skippedFiles: number, diffBytes: number, untrackedBytes: number },
 *   scope: string,
 *   base: string | null,
 *   headSha: string | null,
 *   inputHash: string,
 *   hunks: Array<{ path: string, newStart: number, newEnd: number }>,
 * }}
 */
export function buildReviewInput(envelope, { focus, findingsJson } = {}) {
  const { scope, context, base = null, headSha = null } = envelope;

  const diffEntries = buildDiffEntries(context.diff, diffFallbackPaths(scope, context));
  const { included: untrackedIncluded, skipped } = buildUntrackedEntries(scope, context);
  const included = [...diffEntries, ...untrackedIncluded];

  const truncated = diffTruncationInfo(context.diff);
  const prompt = buildReviewPrompt(envelope, { focus, findingsJson });

  const counts = {
    includedFiles: included.length,
    skippedFiles: skipped.length,
    diffBytes: Buffer.byteLength(typeof context.diff === "string" ? context.diff : "", "utf8"),
    untrackedBytes: sumBytes(untrackedIncluded),
  };

  // Task 14 ("Senate R8", 2026-09): the hunks `review --check-locations`
  // (and a later `result --check-locations`) classifies citations against.
  // Computed here, unconditionally — stored on every review job, not only
  // under the flag, so a job reviewed without it can still be checked later.
  const hunks = [...parseDiffHunks(context.diff), ...untrackedHunks(scope, context)];

  return {
    prompt,
    included,
    skipped,
    truncated,
    counts,
    scope,
    base,
    headSha,
    inputHash: sha256Of(prompt),
    hunks,
  };
}
