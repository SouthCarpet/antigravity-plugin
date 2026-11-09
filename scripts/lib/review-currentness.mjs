/**
 * review-currentness: the check behind `result <job-id> --check-current`
 * (3.2.0, plan 153 package C, item C2).
 *
 * It answers one question about a finished `review` job: would the review
 * input built from the repository NOW be the same as the input the job sent?
 * It does this by running the same two functions `review` ran, with the
 * scope, base, focus and findings flag the job stored:
 * `collectReviewContext` and `buildReviewInput`. Their hash rules (CRLF
 * handling, the diff size cap, skipped files, untracked content) apply
 * unchanged, because no rule is written a second time here.
 *
 * Three statuses:
 * - `match`: the new `inputHash` equals the stored one.
 * - `changed`: both hashes exist and differ.
 * - `unknown`: the check could not run. `reason` says why.
 *
 * The result is a SNAPSHOT of the moment of the call, not a lock. The check
 * reads git only. It never calls agy, never reads or writes job state, and
 * never changes the repository.
 */

import { collectReviewContext } from "./git.mjs";
import { buildReviewInput } from "./review-input.mjs";

/** The base `review --scope auto` tries, in order, when the working tree is clean. */
const DEFAULT_BASES = ["main", "master"];

/** A scope a stored review job can hold (`envelope.scope` is always resolved). */
const STORED_SCOPES = new Set(["working-tree", "branch"]);

/** Reasons carried by `status: "unknown"`. */
export const CURRENT_UNKNOWN_REASONS = Object.freeze([
  "legacy_record",
  "base_not_found",
  "default_base_not_found",
  "collection_failed",
]);

class CurrentnessUnknown extends Error {
  /** @param {string} reason one of {@link CURRENT_UNKNOWN_REASONS} */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * The stored request fields the check needs, or `null` for a record from
 * before they were stored (no hash, a scope that is not resolved, a base
 * that is not a string).
 *
 * @param {any} stored a job detail record
 * @returns {{ scope: string, base: string | null, focus: string | undefined,
 *   findingsJson: boolean, inputHash: string } | null}
 */
function readStoredRequest(stored) {
  const request = stored?.request;
  if (!request || typeof request.inputHash !== "string" || request.inputHash === "") return null;
  if (!STORED_SCOPES.has(request.scope)) return null;
  const base = request.base ?? null;
  if (base !== null && typeof base !== "string") return null;
  return {
    scope: request.scope,
    base,
    focus: typeof request.focus === "string" ? request.focus : undefined,
    findingsJson: request.findingsJson === true,
    inputHash: request.inputHash,
  };
}

function isUnknownBaseRef(error) {
  return typeof error?.message === "string" && error.message.startsWith("unknown base ref");
}

/**
 * A `branch` review with a stored base of `null` was an `auto` review that
 * found a clean working tree and compared against `main`, then `master`.
 * The same rule runs again: the first of the two that resolves today.
 */
function collectDefaultBranch(workspaceRoot, collect) {
  for (const base of DEFAULT_BASES) {
    try {
      return collect(workspaceRoot, { scope: "branch", base });
    } catch (error) {
      if (!isUnknownBaseRef(error)) throw error;
    }
  }
  throw new CurrentnessUnknown("default_base_not_found");
}

function collectAgain(workspaceRoot, request, collect) {
  if (request.scope === "branch" && request.base === null) return collectDefaultBranch(workspaceRoot, collect);
  try {
    return collect(workspaceRoot, { scope: request.scope, base: request.base ?? undefined });
  } catch (error) {
    if (isUnknownBaseRef(error)) throw new CurrentnessUnknown("base_not_found");
    throw error;
  }
}

/**
 * Compare the review input of a stored `review` job with the input built
 * from the repository now. Read-only.
 *
 * @param {string} workspaceRoot the workspace the job was stored for
 * @param {any} stored the job's detail record (`readJobFile`)
 * @param {{ now?: () => Date, collect?: typeof collectReviewContext }} [seams] test seams
 * @returns {{ status: "match" | "changed" | "unknown", reason?: string, checkedAt: string }}
 */
export function checkReviewCurrentness(workspaceRoot, stored, { now = () => new Date(), collect = collectReviewContext } = {}) {
  const checkedAt = now().toISOString();
  const request = readStoredRequest(stored);
  if (!request) return { status: "unknown", reason: "legacy_record", checkedAt };
  try {
    const envelope = collectAgain(workspaceRoot, request, collect);
    const input = buildReviewInput(envelope, { focus: request.focus, findingsJson: request.findingsJson });
    return { status: input.inputHash === request.inputHash ? "match" : "changed", checkedAt };
  } catch (error) {
    const reason = error instanceof CurrentnessUnknown ? error.reason : "collection_failed";
    return { status: "unknown", reason, checkedAt };
  }
}

/**
 * The one stderr/markdown line for `--check-current`, in the same shape as
 * the `--check-locations` line. The word "snapshot" is part of the text so
 * no reader takes the answer for a lock.
 *
 * @param {{ status: string, reason?: string }} check
 * @returns {string}
 */
export function currentnessReportLine(check) {
  const reason = check.reason ? ` (${check.reason})` : "";
  return `antigravity:result — currentness check (snapshot): ${check.status}${reason}.`;
}
