/**
 * review-compare: the value option and comparison behind `review --models
 * a,b` (plan 153 p2, package E, "E1").
 *
 * `--models <a,b>` runs the same review twice, against two different agy
 * models, and compares the structured findings each one returns. This
 * module holds the two pieces that are not already in `job-helpers.mjs` or
 * `review-findings.mjs`: parsing the flag's value, resolving its two model
 * tokens (an exact id, or `alias:<name>` reusing the shipped alias table),
 * and matching one model's findings against the other's.
 *
 * Match rule (controller ruling, plan 153 p2 brief E1): two findings count
 * as the same finding when they name the same `file` and their `line`
 * falls inside the same hunk of the diff sent to both models
 * (`buildReviewInput`'s own `hunks`, the array `review-locations.mjs`
 * already classifies citations against). A finding with `line: null`
 * matches only another `line: null` finding of the same file — there is no
 * hunk to share. `severity` is reported on both sides of a match and is
 * never part of the match; `description`/`recommendation` text is never
 * compared either, because the shipped findings schema
 * (`review-findings.schema.json`) has no `rule` field to match on. A
 * finding matches at most one finding of the other model, chosen in
 * order, so duplicates on one side become extra `onlyA`/`onlyB` entries
 * rather than matching the same finding twice.
 */

import { probeAgyModels } from "./agent-runtime.mjs";
import { parseModelsListing, selectAliasModel } from "./model-alias.mjs";

const ALIAS_PREFIX = "alias:";
const MAX_TOKEN_LENGTH = 200;
const MAX_SHOWN_LENGTH = 80;
// C0, DEL, C1, plus the two Unicode line separators `JSON.stringify` keeps.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, "g");

/**
 * Write every control character (C0, DEL, C1, the Unicode line separators)
 * of `text` as a `\uXXXX` escape, so the result stays on one line.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeControls(text) {
  return String(text).replace(
    CONTROL_CHARS_GLOBAL,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Show caller-controlled text (a `--models` token, a model label, a denied
 * action target) on ONE line: cut to `maxLength` characters, JSON-escaped
 * (quotes included), with every remaining control character escaped by
 * {@link escapeControls}. A cut value ends in `...` after the closing quote.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function escapeForLine(value, maxLength = MAX_SHOWN_LENGTH) {
  const text = String(value);
  const cut = text.length > maxLength ? text.slice(0, maxLength) : text;
  const escaped = escapeControls(JSON.stringify(cut));
  return cut === text ? escaped : `${escaped}...`;
}

/**
 * Refuse one raw token that is too long or holds a control character.
 *
 * @param {string} token
 * @returns {string | null} the refusal reason, or `null` when the token is fine
 */
function tokenShapeProblem(token) {
  if (token.length > MAX_TOKEN_LENGTH) {
    return `--models token ${escapeForLine(token)} is longer than ${MAX_TOKEN_LENGTH} characters`;
  }
  if (CONTROL_CHARS.test(token)) return `--models token ${escapeForLine(token)} holds a control character`;
  return null;
}

/**
 * Parse `--models <value>`'s raw string into its two tokens: exactly two
 * comma-separated, non-empty, distinct tokens, each at most 200 characters
 * and free of control characters (C0, DEL, C1). Each token is taken
 * verbatim here — whether it is an exact model id or an `alias:<name>`
 * form is only decided at resolution time ({@link resolveModelsPair}), so
 * a malformed alias name (an unknown family, or `alias:` with nothing
 * after it) is never a parse-time refusal. Every refusal shows a token
 * through {@link escapeForLine}, so one refusal is always one line.
 *
 * @param {string} raw
 * @returns {{ ok: true, tokens: [string, string] } | { ok: false, reason: string }}
 */
export function parseModelsOption(raw) {
  const parts = String(raw).split(",");
  if (parts.length !== 2) {
    return { ok: false, reason: `--models needs exactly two comma-separated tokens, got ${parts.length}` };
  }
  const [a, b] = parts;
  const problem = tokenShapeProblem(a) ?? tokenShapeProblem(b);
  if (problem) return { ok: false, reason: problem };
  if (!a.trim() || !b.trim()) return { ok: false, reason: "--models token must not be empty" };
  if (a === b) return { ok: false, reason: `--models needs two distinct tokens, got ${escapeForLine(a)} twice` };
  return { ok: true, tokens: [a, b] };
}

/**
 * Keep a long alias name out of a refusal: `selectAliasModel`'s reasons quote
 * the alias, so an alias over the shown length is replaced by its cut form.
 *
 * @param {string} reason
 * @param {string} alias
 * @returns {string}
 */
function cutAliasInReason(reason, alias) {
  if (alias.length <= MAX_SHOWN_LENGTH) return reason;
  return reason.split(alias).join(`${alias.slice(0, MAX_SHOWN_LENGTH)}...`);
}

/**
 * Resolve one `--models` token to an agy model id: an exact id (no lookup,
 * same rule `--model` already follows: "an exact id is never looked up"),
 * or `alias:<name>` resolved through the shipped alias table
 * (`model-alias.mjs`) against an already-fetched listing.
 *
 * @param {string} token
 * @param {{ ok: true, rows: Array<{id: string, name: string}> } | { ok: false, reason: string } | null} listing
 *   the parsed `agy models` listing, or `null` when no token in the pair needs one
 * @param {string | undefined} effort
 * @returns {{ ok: true, model: string, request: object } | { ok: false, reason: string }}
 */
function resolveModelToken(token, listing, effort) {
  if (!token.startsWith(ALIAS_PREFIX)) return { ok: true, model: token, request: {} };
  const alias = token.slice(ALIAS_PREFIX.length);
  if (!listing?.ok) {
    return { ok: false, reason: `model-alias listing unavailable (${listing?.reason ?? "not fetched"}); ` +
      "run setup or pass an exact model id" };
  }
  const selected = selectAliasModel(listing.rows, alias, effort);
  if (!selected.ok) return { ok: false, reason: cutAliasInReason(selected.reason, alias) };
  return { ok: true, model: selected.model, request: { requestedAlias: alias, resolvedModel: selected.model } };
}

/**
 * Resolve both `--models` tokens, fetching the account's model listing at
 * most once for the pair (never when both tokens are exact ids).
 *
 * @param {[string, string]} tokens
 * @param {{ effort?: string, probe?: typeof probeAgyModels }} [options]
 * @returns {Promise<{ ok: true, resolved: [{model: string, request: object}, {model: string, request: object}] } |
 *   { ok: false, reason: string }>}
 */
export async function resolveModelsPair([tokenA, tokenB], { effort, probe = probeAgyModels } = {}) {
  const needsListing = tokenA.startsWith(ALIAS_PREFIX) || tokenB.startsWith(ALIAS_PREFIX);
  let listing = null;
  if (needsListing) {
    const fetched = await probe();
    listing = fetched.ok ? parseModelsListing(fetched.text) : fetched;
  }
  const a = resolveModelToken(tokenA, listing, effort);
  if (!a.ok) return a;
  const b = resolveModelToken(tokenB, listing, effort);
  if (!b.ok) return b;
  if (a.model === b.model) {
    return { ok: false, reason: `--models tokens ${escapeForLine(tokenA)} and ${escapeForLine(tokenB)} ` +
      `both resolve to the model ${escapeForLine(a.model)}; pick two different models` };
  }
  return { ok: true, resolved: [
    { model: a.model, request: a.request },
    { model: b.model, request: b.request },
  ] };
}

/**
 * Normalize a path for comparison the same way `review-locations.mjs`
 * does: backslashes to forward slashes, a leading `./`, `a/`, or `b/`
 * stripped (repeatedly). Not exported there, so this module keeps its own
 * copy rather than reaching into that module's internals.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizeFindingPath(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/^(?:\.\/|a\/|b\/)+/, "");
}

/**
 * The hunk-match group key for one finding: `<path>::null` for a `line:
 * null` finding, `<path>::<hunk index>` for a finding whose line falls
 * inside one of `hunks`' entries on that path, or a key unique to this
 * finding (so it matches nothing) when the line is non-null but no hunk on
 * that path contains it — the match rule only ever shares a hunk, never
 * "the same file, anywhere".
 *
 * @param {{ file: string, line: number | null }} finding
 * @param {Array<{ path: string, newStart: number, newEnd: number }>} hunks
 * @param {string} uniqueSuffix used only for the "no matching hunk" case
 * @returns {string}
 */
function findingGroupKey(finding, hunks, uniqueSuffix) {
  const path = normalizeFindingPath(finding.file);
  if (finding.line === null) return `${path}::null`;
  const hunkIndex = hunks.findIndex(
    (hunk) => normalizeFindingPath(hunk.path) === path && hunk.newStart <= finding.line && finding.line <= hunk.newEnd,
  );
  return hunkIndex === -1 ? `__no-hunk__${uniqueSuffix}` : `${path}::${hunkIndex}`;
}

/**
 * Match model A's findings against model B's, one-to-one, in order (the
 * module doc comment above states the full match rule). Severity is
 * carried on both sides of a match, never compared.
 *
 * @param {Array<{severity: string, file: string, line: number|null, description: string, recommendation: string}>} findingsA
 * @param {Array<{severity: string, file: string, line: number|null, description: string, recommendation: string}>} findingsB
 * @param {Array<{ path: string, newStart: number, newEnd: number }> | null | undefined} hunks
 * @returns {{ bothFlagged: Array<{a: object, b: object}>, onlyA: object[], onlyB: object[] }}
 */
export function compareReviewFindings(findingsA, findingsB, hunks) {
  const hunkArray = Array.isArray(hunks) ? hunks : [];
  const keysA = findingsA.map((finding, i) => findingGroupKey(finding, hunkArray, `a${i}`));
  const keysB = findingsB.map((finding, i) => findingGroupKey(finding, hunkArray, `b${i}`));
  const usedB = new Set();
  const bothFlagged = [];
  const onlyA = [];
  for (let i = 0; i < findingsA.length; i++) {
    const j = keysB.findIndex((key, idx) => !usedB.has(idx) && key === keysA[i]);
    if (j === -1) {
      onlyA.push(findingsA[i]);
      continue;
    }
    usedB.add(j);
    bothFlagged.push({ a: findingsA[i], b: findingsB[j] });
  }
  const onlyB = findingsB.filter((_, idx) => !usedB.has(idx));
  return { bothFlagged, onlyA, onlyB };
}
