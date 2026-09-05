/**
 * Workspace root resolution.
 */

import { ensureGitRepository } from "./git.mjs";

const workspaceRootCache = new Map();

/**
 * Resolve the workspace root directory. Falls back to `cwd` if not inside a
 * git repository.
 *
 * Cached per `cwd` string for the process lifetime: a cwd's git identity
 * cannot change within one CLI invocation or worker run, but every
 * `state.mjs` accessor (readJobFile, ensureStateDir, writeJobFile, ...)
 * calls this via `resolveStateDir`, so one job-lifecycle operation used to
 * spawn `git rev-parse` a dozen-plus times over. Fix brief 076-T4-fix2 F1:
 * measured on this machine, a background worker's `git rev-parse` costs
 * ~3.4s per call (vs ~0.1s in the foreground test process — the cause is a
 * per-spawn tax specific to launching git from a detached/background child,
 * reproduced with and without other test scaffolding; not conclusively
 * attributed to any one mechanism). Eliminating the redundant calls, not
 * widening a timeout, is what closed the flake (see the fix report for the
 * before/after stage timestamps).
 *
 * @param {string} cwd
 * @param {{ ensureGitRepository?: typeof ensureGitRepository }} [seam] test-only
 *   injection point, mirroring `processStartedAt`'s `spawnSyncImpl` seam in
 *   `process.mjs`.
 * @returns {string}
 */
export function resolveWorkspaceRoot(cwd, { ensureGitRepository: ensure = ensureGitRepository } = {}) {
  const key = String(cwd);
  const cached = workspaceRootCache.get(key);
  if (cached !== undefined) return cached;

  let root;
  try {
    root = ensure(cwd);
  } catch {
    root = cwd;
  }
  workspaceRootCache.set(key, root);
  return root;
}
