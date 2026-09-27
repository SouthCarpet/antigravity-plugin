/**
 * review-findings: the local check behind `review --findings-json` (Senate
 * R7, 2026-09).
 *
 * agy 1.2.12 accepts `--json-schema <path>` on the stream-json transport and
 * puts the model's structured answer on the final `result` event as
 * `structured_output` (measured: agy-1.2.12-20260927/probe-json-schema.txt).
 * The same probe showed `result.response` carrying keys the schema did not
 * allow, so the plugin never trusts agy's own enforcement: it validates
 * `structured_output` here, against the schema file it ships next to this
 * module, and never parses `response` at all.
 *
 * The schema file is the single source of the shape. This module interprets
 * the small JSON Schema subset that file uses ({@link SUPPORTED_SCHEMA_KEYWORDS})
 * instead of restating the shape in code, and has no dependency.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the shipped schema; forwarded to agy as `--json-schema`. */
export const REVIEW_FINDINGS_SCHEMA_PATH = fileURLToPath(new URL("./review-findings.schema.json", import.meta.url));

const SCHEMA = JSON.parse(readFileSync(REVIEW_FINDINGS_SCHEMA_PATH, "utf8"));

/** Every JSON Schema keyword this validator implements. */
export const SUPPORTED_SCHEMA_KEYWORDS = [
  "type", "enum", "maxLength", "maxItems", "items", "properties", "required", "additionalProperties",
];

const MAX_ERROR_LENGTH = 300;

/**
 * The JSON Schema type name of a parsed JSON value.
 *
 * @param {unknown} value
 * @returns {string}
 */
function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function checkType(schema, value, where) {
  if (schema.type === undefined) return null;
  const allowed = [].concat(schema.type);
  const actual = jsonTypeOf(value);
  if (allowed.includes(actual) || (actual === "integer" && allowed.includes("number"))) return null;
  return `${where}: expected ${allowed.join(" or ")}, got ${actual}`;
}

function checkEnum(schema, value, where) {
  if (!schema.enum || schema.enum.includes(value)) return null;
  return `${where}: must be one of ${schema.enum.join(", ")}`;
}

function checkString(schema, value, where) {
  if (typeof value !== "string" || schema.maxLength === undefined) return null;
  // JSON Schema counts code points, not UTF-16 units.
  if ([...value].length <= schema.maxLength) return null;
  return `${where}: longer than ${schema.maxLength} characters`;
}

function checkArray(schema, value, where) {
  if (!Array.isArray(value)) return null;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    return `${where}: more than ${schema.maxItems} items`;
  }
  if (!schema.items) return null;
  for (let i = 0; i < value.length; i++) {
    const error = checkNode(schema.items, value[i], `${where}[${i}]`);
    if (error) return error;
  }
  return null;
}

function checkObject(schema, value, where) {
  if (jsonTypeOf(value) !== "object") return null;
  const properties = schema.properties ?? {};
  const missing = (schema.required ?? []).find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return `${where}: missing required key "${missing}"`;
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
    if (extra !== undefined) return `${where}: unexpected key "${extra}"`;
  }
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const error = checkNode(child, value[key], `${where}.${key}`);
    if (error) return error;
  }
  return null;
}

/**
 * The first schema violation at `value`, or `null` when it conforms.
 *
 * @param {object} schema
 * @param {unknown} value
 * @param {string} where display path of `value`
 * @returns {string | null}
 */
function checkNode(schema, value, where) {
  return checkType(schema, value, where)
    ?? checkEnum(schema, value, where)
    ?? checkString(schema, value, where)
    ?? checkArray(schema, value, where)
    ?? checkObject(schema, value, where);
}

/**
 * One printable line: control characters (an echoed key may carry any)
 * dropped, length capped.
 *
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_ERROR_LENGTH);
}

/**
 * Parse agy's structured output: a JSON string is parsed, any other value
 * is taken as already parsed.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function parseStructured(raw) {
  if (typeof raw !== "string") return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Validate agy's structured review output against the shipped schema.
 *
 * @param {unknown} raw the `result` event's `structured_output` (an object
 *   or a string), or its stored `structuredRaw` JSON text; `null`/`undefined`
 *   when agy sent none
 * @returns {{ status: "valid" | "invalid" | "missing", findings: object | null, error: string | null }}
 */
export function validateReviewFindings(raw) {
  if (raw === null || raw === undefined) {
    return { status: "missing", findings: null, error: "agy returned no structured output" };
  }
  const parsed = parseStructured(raw);
  if (!parsed.ok) return { status: "invalid", findings: null, error: "structured output is not valid JSON" };
  const error = checkNode(SCHEMA, parsed.value, "result");
  if (error) return { status: "invalid", findings: null, error: oneLine(error) };
  return { status: "valid", findings: parsed.value, error: null };
}

/**
 * The `details` fields `review --findings-json` and `result <id>` report:
 * `findings` + `findingsStatus: "valid"`, or `findings: null` +
 * `findingsStatus` + a one-line `findingsError`.
 *
 * @param {unknown} raw see {@link validateReviewFindings}
 * @returns {{ findings: object | null, findingsStatus: string, findingsError?: string }}
 */
export function reviewFindingsDetails(raw) {
  const { status, findings, error } = validateReviewFindings(raw);
  if (status === "valid") return { findings, findingsStatus: status };
  return { findings: null, findingsStatus: status, findingsError: error };
}

/**
 * The one stderr warning line for findings that are not valid, or `null`.
 *
 * @param {string} kind verb name
 * @param {{ findingsStatus?: string, findingsError?: string }} details
 * @returns {string | null}
 */
export function findingsWarningLine(kind, details) {
  if (!details.findingsStatus || details.findingsStatus === "valid") return null;
  return `antigravity:${kind} — warning: structured findings ${details.findingsStatus}: ${details.findingsError}`;
}

/**
 * The JSON text stored as `result.structuredRaw`: a string as agy sent it,
 * any other value serialized, `null` when agy sent none.
 *
 * @param {unknown} structured
 * @returns {string | null}
 */
export function structuredRawText(structured) {
  if (structured === null || structured === undefined) return null;
  return typeof structured === "string" ? structured : JSON.stringify(structured);
}

/**
 * The findings `details` for a stored job, or `{}` when the job did not ask
 * for findings or has not completed. Validated at read time from the stored
 * `result.structuredRaw`. `stored` (the per-job file) wins over `job` (its
 * index entry) for `status` and `request`, the order `buildResultDetails`
 * uses for every field.
 *
 * @param {import('./types.mjs').JobRecord | null} stored
 * @param {import('./types.mjs').JobRecord | import('./types.mjs').JobIndexEntry | null} [job]
 * @returns {object}
 */
export function storedFindingsDetails(stored, job = stored) {
  const request = stored?.request ?? job?.request;
  const status = stored?.status ?? job?.status;
  if (request?.findingsJson !== true || status !== "completed") return {};
  return reviewFindingsDetails(stored?.result?.structuredRaw ?? null);
}
