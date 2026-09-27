/**
 * `--request-id <id>`: opt-in idempotent background dispatch on `task` and
 * `rescue --background` (Senate R12, 2026-09).
 *
 * This module holds the flag's own validation and the request fingerprint.
 * The claim itself (look up the id, create the job, record the mapping, all
 * under one workspace lock) lives in `state.mjs#claimRequestId`; the
 * background dispatch that calls it lives in
 * `job-helpers.mjs#startBackgroundJob`.
 */

import { createHash } from "node:crypto";

import { ArgsError } from "./args.mjs";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** The request fields a fingerprint covers, in no particular order. */
const FINGERPRINT_FIELDS = ["kind", "prompt", "mode", "conversationId", "addDirs", "extraArgs", "model", "effort", "cwd"];

/**
 * Parser-level check for `--request-id` (an `args.mjs` `schema.validate`
 * hook): the id must be 1 to 128 characters from `[A-Za-z0-9._-]`, and the
 * run must be a background one (`task` without `--foreground`, `rescue`
 * with `--background`). Absent flag: no-op.
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @param {"task" | "rescue"} kind
 * @returns {void}
 * @throws {ArgsError}
 */
export function validateRequestIdOption(options, kind) {
  const value = options["request-id"];
  if (value === undefined) return;
  if (!REQUEST_ID_RE.test(String(value))) {
    throw new ArgsError(
      `invalid value for --request-id: ${JSON.stringify(String(value))} ` +
      "(expected 1 to 128 characters from A-Z, a-z, 0-9, '.', '_', '-')",
    );
  }
  const background = kind === "task" ? !options.foreground : Boolean(options.background);
  if (!background) throw new ArgsError("--request-id applies to background jobs only");
}

/**
 * JSON with object keys sorted at every level and no whitespace.
 * `undefined` serializes as `null`, so an absent field and an explicit
 * `null` hash the same.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * sha256 hex over the canonical JSON of `{ kind, prompt, mode,
 * conversationId, addDirs, extraArgs, model, effort, cwd }`. Other keys on
 * `fields` are ignored; a missing one counts as `null`.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function requestFingerprint(fields) {
  const picked = Object.fromEntries(FINGERPRINT_FIELDS.map((key) => [key, fields[key] ?? null]));
  return createHash("sha256").update(canonicalJson(picked)).digest("hex");
}
