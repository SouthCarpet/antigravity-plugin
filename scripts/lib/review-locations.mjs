/**
 * review-locations: the heuristic citation-location check behind `review
 * --check-locations` and `result --check-locations` (Task 14, "Senate R8",
 * 2026-09).
 *
 * A review answer often cites `<path>:<line>`. This module finds those
 * citations in the answer text and classifies each against the hunks the
 * sent diff actually carried (`request.hunks`, built by `buildReviewInput`
 * in `review-input.mjs`): `in_diff` (the path matches a hunk and the cited
 * line, or the whole cited range, lies inside it), `outside_diff` (the path
 * matches but the line does not), or `unknown_path` (no hunk names that
 * path at all). This is a heuristic, not a truth check: a citation the diff
 * did not touch is not by itself a model error — reviewers legitimately
 * cite context lines and related files outside the diff.
 *
 * `checkReviewLocations` never calls agy and never changes `answer` or the
 * exit code; it only reads the text already produced.
 */

/**
 * One `<path>:<line>` or `<path>:<start>-<end>` citation. Tuned to exclude
 * two shapes the base pattern would otherwise catch: a bare `\d+.\d+.\d+`
 * version string (`1.2.11:5`), and a `http(s)://` URL whose path segment
 * happens to look like `<name>.<ext>:<port-or-line>` right after the
 * scheme. Everything else this pattern matches is treated as a citation
 * candidate; `docs/COMPATIBILITY.md` records the measured false-positive
 * rate against two stored review transcripts (neither carried a real
 * `path:line` citation at all, so the count there is zero) — per the brief,
 * this is tuned for those two named shapes and does not chase every case
 * (a bare `host:port` with no `http(s)://` prefix, for one, still matches).
 */
const CITATION_RE = /(?<![\w/])([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

/** A path that is actually a three-part version number, e.g. `1.2.11`. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** True when `text` ends with an unadorned `http:` or `https:` scheme. */
const URL_SCHEME_TAIL_RE = /https?:$/;

/** How many characters of context before a match are enough to see a scheme. */
const SCHEME_LOOKBACK = 6;

/**
 * True when `rawPath` and the text immediately before it, together, spell
 * out a `http(s)://` URL — `[\w./-]` (the citation pattern's own path
 * class) already allows `/`, so a URL's `//` lands INSIDE the match itself,
 * right after the `https:`/`http:` this checks for just before it, rather
 * than being consumed by the match's own leading lookbehind.
 *
 * @param {string} text
 * @param {number} index start of the full match in `text`
 * @param {string} rawPath the matched path group, unnormalized
 * @returns {boolean}
 */
function isUrlContinuation(text, index, rawPath) {
  if (!rawPath.startsWith("//")) return false;
  return URL_SCHEME_TAIL_RE.test(text.slice(Math.max(0, index - SCHEME_LOOKBACK), index));
}

/**
 * Normalize a path for comparison: backslashes to forward slashes, then a
 * leading `./`, `a/`, or `b/` stripped (repeatedly, so `a/./x` and similar
 * still resolve) — the same normalisation a diff-derived hunk path and an
 * answer's cited path both need before they can be compared.
 *
 * @param {string} path
 * @returns {string}
 */
function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/|a\/|b\/)+/, "");
}

/**
 * Every citation candidate in `answer`, after dropping a version string or
 * a URL continuation. Each carries the normalized path and both line
 * endpoints (a single-line citation has `line === endLine`), so
 * classification only ever compares numbers.
 *
 * @param {string} answer
 * @returns {Array<{ text: string, path: string, line: number, endLine: number }>}
 */
function findCitations(answer) {
  const citations = [];
  for (const match of answer.matchAll(CITATION_RE)) {
    const [text, rawPath, startText, endText] = match;
    if (VERSION_RE.test(rawPath) || isUrlContinuation(answer, match.index, rawPath)) continue;
    citations.push({
      text,
      path: normalizePath(rawPath),
      line: Number(startText),
      endLine: endText === undefined ? Number(startText) : Number(endText),
    });
  }
  return citations;
}

/**
 * `true` when some hunk on `path` fully contains the citation's line (or,
 * for a range citation, its whole range).
 *
 * @param {{ line: number, endLine: number }} citation
 * @param {Array<{ path: string, newStart: number, newEnd: number }>} hunksForPath
 * @returns {boolean}
 */
function isInsideAHunk(citation, hunksForPath) {
  return hunksForPath.some((hunk) => hunk.newStart <= citation.line && citation.endLine <= hunk.newEnd);
}

/**
 * `in_diff`, `outside_diff`, or `unknown_path` for one citation, against
 * `hunks` (already normalized-path entries; `path` on `citation` is already
 * normalized by {@link findCitations}).
 *
 * @param {{ path: string, line: number, endLine: number }} citation
 * @param {Array<{ path: string, newStart: number, newEnd: number }>} hunks
 * @returns {"in_diff" | "outside_diff" | "unknown_path"}
 */
function classifyCitation(citation, hunks) {
  const hunksForPath = hunks.filter((hunk) => normalizePath(hunk.path) === citation.path);
  if (hunksForPath.length === 0) return "unknown_path";
  return isInsideAHunk(citation, hunksForPath) ? "in_diff" : "outside_diff";
}

/**
 * The heuristic citation-location check (Task 14, "Senate R8", 2026-09):
 * every citation `answer` names, each classified against `hunks`.
 *
 * `hunks` must be the array `buildReviewInput` stored on the job
 * (`request.hunks`); `null`/`undefined` (a job stored before this feature
 * shipped) means the check cannot run at all, and this returns `null` — the
 * caller reports that as "location check unavailable", distinct from a
 * check that ran and simply found no citations.
 *
 * @param {string} answer
 * @param {Array<{ path: string, newStart: number, newEnd: number }> | null | undefined} hunks
 * @returns {{ heuristic: true, citations: Array<{ text: string, path: string, line: number,
 *   state: "in_diff" | "outside_diff" | "unknown_path" }>, counts: { in_diff: number,
 *   outside_diff: number, unknown_path: number } } | null}
 */
export function checkReviewLocations(answer, hunks) {
  if (!Array.isArray(hunks)) return null;
  const text = typeof answer === "string" ? answer : "";
  const counts = { in_diff: 0, outside_diff: 0, unknown_path: 0 };
  const citations = findCitations(text).map((citation) => {
    const state = classifyCitation(citation, hunks);
    counts[state] += 1;
    return { text: citation.text, path: citation.path, line: citation.line, state };
  });
  return { heuristic: true, citations, counts };
}

/**
 * The one stderr/markdown line for a location check that ran:
 * `antigravity:<kind> — location check (heuristic): <in> in diff, <out>
 * outside diff, <unknown> unknown paths.`
 *
 * @param {string} kind verb name (`review` or `result`)
 * @param {{ in_diff: number, outside_diff: number, unknown_path: number }} counts
 * @returns {string}
 */
export function locationCheckSummaryLine(kind, counts) {
  return `antigravity:${kind} — location check (heuristic): ${counts.in_diff} in diff, ` +
    `${counts.outside_diff} outside diff, ${counts.unknown_path} unknown paths.`;
}

/**
 * The one stderr/markdown line for `--check-locations` on a job stored
 * before `request.hunks` existed.
 *
 * @param {string} kind verb name (`review` or `result`)
 * @returns {string}
 */
export function locationCheckUnavailableLine(kind) {
  return `antigravity:${kind} — location check unavailable: this job predates hunk storage.`;
}

/**
 * The one report line for `--check-locations`, chosen by whether the check
 * itself was able to run: {@link locationCheckSummaryLine} for a result,
 * {@link locationCheckUnavailableLine} for `null` (no stored hunks). The
 * single call site both `review.mjs` and `result.mjs` use once they already
 * know the flag was given — this never decides whether to print anything.
 *
 * @param {string} kind verb name (`review` or `result`)
 * @param {ReturnType<typeof checkReviewLocations>} locationCheck
 * @returns {string}
 */
export function locationCheckReportLine(kind, locationCheck) {
  return locationCheck ? locationCheckSummaryLine(kind, locationCheck.counts) : locationCheckUnavailableLine(kind);
}
