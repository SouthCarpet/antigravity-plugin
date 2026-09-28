/**
 * job-result: the completed-job `details` projection shared by
 * `result.mjs` (`result <id> --json`) and `job-helpers.mjs`'s
 * `--show-result` background-wait envelope (Task 7, "Senate R9", 2026-09).
 *
 * Split out of `result.mjs` into its own module, rather than exported from
 * `job-helpers.mjs` or imported back into it, because `job-helpers.mjs`
 * already exports helpers `result.mjs` imports (`classifyStateError`,
 * `exitCodeForJobStatus`, `deniedActionsWithRemedy`,
 * `printMeasuredUsageTrailer`); a `job-helpers.mjs` export importing
 * `result.mjs` back would be circular. This module depends on neither.
 */

import { storedFindingsDetails } from "./review-findings.mjs";

/**
 * The `details.inputHash` value: the job's own `request.inputHash`, `stored`
 * taking priority over the index entry `job` (same priority order every
 * other field in {@link buildResultDetails} uses), or `null` for a legacy
 * record, a non-review job, or a review that never reached input selection
 * (e.g. `no_changes`).
 *
 * @param {import('./types.mjs').JobRecord | null} stored
 * @param {import('./types.mjs').JobIndexEntry} job
 * @returns {string | null}
 */
export function resolveInputHash(stored, job) {
  if (stored?.request?.inputHash) return stored.request.inputHash;
  return job.request?.inputHash ?? null;
}

/**
 * The job-detail fields both `result <id> --json` and a `--show-result`
 * completion envelope carry under `details`: `conversationId` (the id the
 * caller passed in), `agyConversationId` (the id agy itself reported),
 * `provenance`, `inputHash`, `reportedModel`, and the full stored `result`
 * object (with `rawOutput` swapped for `cut.text` when a `--head`/`--tail`
 * cut applied; `result <id>` is the only caller that ever passes a `cut`
 * with `truncated: true`; a `--show-result` wait never cuts the answer, so
 * it always passes the default). A completed `review --findings-json` job
 * (Senate R7, 2026-09) also gets `findings`, `findingsStatus` and, when not
 * valid, `findingsError`, validated here from the stored `structuredRaw`.
 *
 * @param {import('./types.mjs').JobIndexEntry} job
 * @param {import('./types.mjs').JobRecord | null} stored
 * @param {{ truncated: boolean, text?: string }} cut
 * @returns {{ conversationId: string | null, agyConversationId: string | null,
 *   provenance: import('./types.mjs').JobProvenance | null,
 *   inputHash: string | null,
 *   reportedModel: string | null, result: object | null }}
 */
export function buildResultDetails(job, stored, cut) {
  const result = stored?.result ?? null;
  const rawOutput =
    cut?.truncated && typeof result?.rawOutput === "string" ? cut.text : result?.rawOutput;
  return {
    conversationId: stored?.conversationId ?? job.conversationId ?? null,
    // The id agy itself reported, distinct from `conversationId` above (the
    // id the caller passed in), already nested at `result.agyConversationId`
    // via `buildStoredResult`; also surfaced at this top level (plan 086 T5k
    // F1 item 2) so a host reading `result <id> --json` finds it in the same
    // place `status <id> --json`'s `details.job.agyConversationId` puts it.
    agyConversationId: stored?.result?.agyConversationId ?? null,
    // Plan 103 T2 ("Senate R11", 2026-09): the job's own provenance record
    // and agy's reported model, both `null` on a legacy record or a run agy
    // never reported a model for. `provenance` is the same object `status
    // <id> --json` puts at `details.job.provenance`.
    provenance: stored?.provenance ?? job.provenance ?? null,
    inputHash: resolveInputHash(stored, job),
    reportedModel: result?.reportedModel ?? null,
    result: result ? { ...result, rawOutput } : result,
    ...storedFindingsDetails(stored, job),
  };
}
