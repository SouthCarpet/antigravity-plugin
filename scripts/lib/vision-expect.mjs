/**
 * vision-expect.mjs — local, no-agy check for `vision --expect` (Senate R6,
 * 2026-09).
 *
 * `--expect <text>` names a string a human expects the image's transcribed
 * text to contain. The check below runs after the answer comes back: it
 * reads the `## Transcription` section {@link buildVisionPrompt}
 * (prompt-templates.mjs) already asks agy to produce, and looks for each
 * expected value inside it. It is a substring check on what agy already
 * said, never a truth check of the image itself, and it spawns nothing.
 */

import { ArgsError } from "./args.mjs";

/** The exact, case-sensitive heading line the transcription section starts at. */
const TRANSCRIPTION_HEADING = "## Transcription";

/** A markdown heading line one level up from `## Transcription`'s own
 * sub-headings (`### Image N: ...`): the section ends at the next line that
 * starts with this, or at the end of the text. */
const NEXT_HEADING_PREFIX = "## ";

/** The whole answer is nothing but this one sentinel line (`buildVisionPrompt`'s
 * `VISION-UNAVAILABLE: <reason>` contract) when trimmed. */
const UNAVAILABLE_ONLY_RE = /^VISION-UNAVAILABLE:.*$/;

/** `--expect` accepts at most this many values per run. */
export const MAX_EXPECT_VALUES = 32;

/**
 * `schema.validate` for `vision`'s `--expect` (repeatable): trims every
 * value in place, then refuses an empty value or more than
 * {@link MAX_EXPECT_VALUES} values. Absent `--expect` is not an error — a
 * run with no `--expect` at all skips the check entirely.
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @returns {void}
 */
export function validateExpectOption(options) {
  const raw = options.expect;
  if (raw === undefined) return;
  const trimmed = raw.map((value) => String(value).trim());
  if (trimmed.some((value) => value === "")) {
    throw new ArgsError("invalid value for --expect: empty or whitespace-only");
  }
  if (trimmed.length > MAX_EXPECT_VALUES) {
    throw new ArgsError(`invalid value for --expect: at most ${MAX_EXPECT_VALUES} values allowed`);
  }
  options.expect = trimmed;
}

/**
 * The `## Transcription` section body of a vision answer: the heading line
 * exactly `## Transcription` (case-sensitive), up to but not including the
 * next line starting with `## `, or the end of the text.
 *
 * @param {string} answer
 * @returns {{ text: string, lines: string[] } | null} `null` when the
 *   heading is absent
 */
function extractTranscriptionSection(answer) {
  const lines = answer.split("\n");
  const headingIndex = lines.indexOf(TRANSCRIPTION_HEADING);
  if (headingIndex === -1) return null;
  const bodyLines = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith(NEXT_HEADING_PREFIX)) break;
    bodyLines.push(lines[i]);
  }
  return { text: bodyLines.join("\n"), lines: bodyLines };
}

/**
 * True when the whole answer is nothing but the single
 * `VISION-UNAVAILABLE: <reason>` sentinel line.
 *
 * @param {string} answer
 * @returns {boolean}
 */
function isUnavailableOnly(answer) {
  return UNAVAILABLE_ONLY_RE.test(answer.trim());
}

/**
 * One expected value is found when it equals a transcription line exactly
 * (both trimmed) or is a substring of the section's full text.
 *
 * @param {string} value already-trimmed `--expect` value
 * @param {{ text: string, lines: string[] }} section
 * @returns {boolean}
 */
function expectationFound(value, section) {
  if (section.lines.some((line) => line.trim() === value)) return true;
  return section.text.includes(value);
}

/**
 * Check every `--expect` value against a completed vision answer.
 *
 * When the `## Transcription` section is absent, or the whole answer is the
 * single `VISION-UNAVAILABLE:` line, the check cannot run at all: every
 * expectation comes back `found: null` with a reason, and the summary is
 * `"unverifiable"`. Otherwise each value is checked independently and the
 * summary is `"all_found"` or `"missing"`.
 *
 * @param {string} answer the completed run's raw answer text (`result.stdout`)
 * @param {string[]} expectValues already-trimmed `--expect` values, in order
 * @returns {{ expectations: Array<{ value: string, found: boolean | null, reason?: string }>,
 *   expectationSummary: "all_found" | "missing" | "unverifiable" }}
 */
export function checkVisionExpectations(answer, expectValues) {
  const text = answer ?? "";
  const section = extractTranscriptionSection(text);
  if (!section || isUnavailableOnly(text)) {
    return {
      expectations: expectValues.map((value) => (
        { value, found: null, reason: "no transcription section" }
      )),
      expectationSummary: "unverifiable",
    };
  }
  const expectations = expectValues.map((value) => ({ value, found: expectationFound(value, section) }));
  const expectationSummary = expectations.every((entry) => entry.found) ? "all_found" : "missing";
  return { expectations, expectationSummary };
}

/**
 * Render the markdown block `writeExpectationsBlock` appends after the
 * answer (Senate R6, 2026-09): the header line always prints; a `"missing"`
 * summary adds one `  missing: <value>` line per value not found; an
 * `"unverifiable"` summary adds the one fixed `  unverifiable: ...` line
 * instead. `"all_found"` adds nothing beyond the header.
 *
 * @param {{ expectations: Array<{ value: string, found: boolean | null }>,
 *   expectationSummary: "all_found" | "missing" | "unverifiable" }} result
 * @returns {string}
 */
export function formatExpectationsMarkdown({ expectations, expectationSummary }) {
  const lines = [`Expectations: ${expectationSummary}`];
  if (expectationSummary === "unverifiable") {
    lines.push("  unverifiable: no transcription section");
  } else {
    for (const { value, found } of expectations) {
      if (!found) lines.push(`  missing: ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
