/**
 * Workspace root resolution.
 */

import { ensureGitRepository } from "./git.mjs";

const workspaceRootCache = new Map();

// Test-only: total `resolveWorkspaceRoot` invocations (cache hit or miss)
// since the last `resetWorkspaceRootCache()` call. The per-cwd cache below
// absorbs a redundant re-resolution of the SAME cwd string, so counting git
// spawns (or cache misses) alone cannot tell a caller that resolves once and
// passes the root down from one that keeps re-resolving an already-resolved
// root apart, once both calls share one cwd string (076-T6 fix round 1 F1).
let resolveCallCount = 0;

/**
 * Resolve the workspace root directory. Falls back to `cwd` if not inside a
 * git repository.
 *
 * Cached per `cwd` string for the process lifetime: a cwd's git identity
 * cannot change within one CLI invocation or worker run, but every
 * `state.mjs` accessor (readJobFile, ensureStateDir, writeJobFile, ...)
 * calls this via `resolveStateDir`, so one job-lifecycle operation used to
 * spawn `git rev-parse` a dozen-plus times over. Fix brief 076-T4-fix2 F1:
 * the per-call cost of that spawn from a freshly started background worker
 * varies by session on the reference machine (about 3.4 s in one session,
 * under 0.5 s in another; the cause of the gap is not attributed), so the
 * count of calls, not the cost of one, is what made the worker's first
 * locked state update take up to 50 s. Eliminating the redundant calls, not
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
  resolveCallCount += 1;
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

/**
 * Test-only: clear the per-cwd cache (and the call counter below) so a
 * launch-count assertion starts cold instead of inheriting a hit from an
 * earlier test's cwd (076-T6 R4; the missing reset was flagged as a
 * test-isolation footgun in the T4 fix round 2 re-review). Never called from
 * production code — every real process starts with an empty cache already.
 *
 * @returns {void}
 */
export function resetWorkspaceRootCache() {
  workspaceRootCache.clear();
  resolveCallCount = 0;
}

/**
 * Test-only: number of `resolveWorkspaceRoot` calls (cache hit or miss)
 * since the last `resetWorkspaceRootCache()`. Proves the R4 pass-down
 * independent of the per-cwd cache, which a git-spawn count alone cannot do
 * once the caller re-resolves the SAME already-resolved cwd string (076-T6
 * fix round 1 F1).
 *
 * @returns {number}
 */
export function getResolveWorkspaceRootCallCount() {
  return resolveCallCount;
}
