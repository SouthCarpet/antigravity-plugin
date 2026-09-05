/**
 * Deep tests for scripts/lib/job-control.mjs and the status/result/cancel
 * helpers it powers.
 *
 * All tests are pure data-driven: we seed jobs via state.mjs (no subprocesses)
 * and exercise buildStatusSnapshot, buildSingleJobSnapshot, resolveResultJob,
 * resolveCancelableJob, plus the classifyRuntimeHealth branches (active /
 * quiet / possibly_stalled / worker_missing / persisted_diagnostic).
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

// The owned git seam (076-T6 R4): `workspace.mjs`'s `resolveWorkspaceRoot`
// imports `ensureGitRepository` from here, so mocking it before `state.mjs`/
// `job-control.mjs` are ever imported (mocks registered after a module has
// already been loaded do not retroactively apply) lets the launch-count case
// below count real "git" calls without spawning a process. `workCwd` in this
// file is never a real git repository, so returning it unchanged mirrors the
// existing non-git fallback exactly — no other test's behaviour changes.
let gitCalls = 0;
mock.module('../scripts/lib/git.mjs', {
  namedExports: {
    ensureGitRepository: (cwd) => {
      gitCalls += 1;
      return cwd;
    },
  },
});

const {
  upsertJob,
  writeJobFile,
  appendJobLog,
  ensureStateDir,
  saveState,
  resolveJobLogFile,
} = await import('../scripts/lib/state.mjs');
const { resetWorkspaceRootCache, getResolveWorkspaceRootCallCount } = await import('../scripts/lib/workspace.mjs');
const {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  resolveResultJob,
  resolveCancelableJob,
  SESSION_ID_ENV,
  QUIET_AFTER_MS,
  POSSIBLY_STALLED_AFTER_MS,
} = await import('../scripts/lib/job-control.mjs');

const TMPROOT = portableTmpRoot();

let workCwd;
let dataDir;
const savedEnv = {};

beforeEach(() => {
  // Fresh workspace + data dir per test so the on-disk state is deterministic.
  workCwd = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jc-'));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jc-data-'));
  savedEnv.CLAUDE_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;
  savedEnv[SESSION_ID_ENV] = process.env[SESSION_ID_ENV];
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  process.env[SESSION_ID_ENV] = 'sess-' + randomBytes(2).toString('hex');
});

afterEach(() => {
  // Best-effort restore.
  if (savedEnv.CLAUDE_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = savedEnv.CLAUDE_PLUGIN_DATA;
  if (savedEnv[SESSION_ID_ENV] === undefined) delete process.env[SESSION_ID_ENV];
  else process.env[SESSION_ID_ENV] = savedEnv[SESSION_ID_ENV];
  removeTestDir(workCwd);
  removeTestDir(dataDir);
});

async function seedJob(overrides = {}) {
  const id = overrides.id ?? randomBytes(4).toString('hex');
  const sessionId = overrides.sessionId ?? process.env[SESSION_ID_ENV];
  const job = {
    id,
    kind: 'task',
    status: 'queued',
    phase: 'queued',
    sessionId,
    pid: null,
    createdAt: new Date(2024, 0, 1, 0, 0, 0).toISOString(),
    updatedAt: new Date(2024, 0, 1, 0, 0, 1).toISOString(),
    logFile: resolveJobLogFile(workCwd, id),
    ...overrides,
  };
  await upsertJob(workCwd, job);
  await writeJobFile(workCwd, id, { ...job, request: null, result: null });
  return job;
}

describe('buildStatusSnapshot', () => {
  it('partitions session jobs into running/recent and respects maxJobs', async () => {
    await seedJob({ id: 'a', status: 'running' });
    await seedJob({ id: 'b', status: 'queued' });
    await seedJob({ id: 'c', status: 'completed', completedAt: new Date().toISOString() });
    await seedJob({ id: 'd', status: 'failed' });

    const snap = buildStatusSnapshot(workCwd, { env: process.env, maxJobs: 2 });
    assert.equal(snap.running.length, 2);
    assert.equal(snap.recent.length, 2);
    assert.ok(snap.running.some((j) => j.id === 'a'));
    assert.ok(snap.recent.some((j) => j.id === 'c'));
    assert.equal(snap.needsReview, false);
    assert.ok(snap.workspaceRoot.length > 0);
  });

  it('falls back to all jobs when no session id is set', async () => {
    await seedJob({ id: 'q', status: 'running', sessionId: 'other-session' });
    delete process.env[SESSION_ID_ENV];
    const snap = buildStatusSnapshot(workCwd, { env: { /* no session */ } });
    assert.ok(snap.running.some((j) => j.id === 'q'));
  });

  // 076-T6 R4: state.mjs no longer re-resolves an already-resolved workspace
  // root, so a snapshot over several stored jobs calls `resolveWorkspaceRoot`
  // (and so launches "git", the owned seam mocked at the top of this file) at
  // most once. The cache is reset right before the assertion so a warm hit
  // from a cache the seeding calls may have populated cannot mask a
  // regression (test-isolation footgun flagged on the T4 fix round 2
  // re-review).
  //
  // Fix round 1 F1: asserting on `gitCalls` alone does not discriminate a
  // regression where `resolveStateDir` re-resolves the SAME already-resolved
  // cwd string — the per-cwd cache absorbs that redundant call before it
  // ever reaches the mocked `ensureGitRepository`, so `gitCalls` stays 1
  // either way (reproduced: reverting `resolveStateDir` to
  // `resolveWorkspaceRoot(cwd)` left `gitCalls` at 1 while
  // `getResolveWorkspaceRootCallCount()` rose to 6). Asserting on the entry
  // counter as well closes that gap; `gitCalls` stays as a secondary,
  // independent measurement of the same win.
  it('resolves the workspace root at most once for a status snapshot over three stored jobs', async () => {
    await seedJob({ id: 'g1', status: 'completed' });
    await seedJob({ id: 'g2', status: 'completed' });
    await seedJob({ id: 'g3', status: 'completed' });

    resetWorkspaceRootCache();
    gitCalls = 0;
    buildStatusSnapshot(workCwd, { env: process.env });
    assert.equal(getResolveWorkspaceRootCallCount(), 1);
    assert.equal(gitCalls, 1);
  });
});

describe('buildSingleJobSnapshot', () => {
  it('resolves by exact id, partial id, and 1-based positional index', async () => {
    await seedJob({ id: 'abcd1234', status: 'running' });
    const exact = buildSingleJobSnapshot(workCwd, 'abcd1234');
    assert.equal(exact.job.id, 'abcd1234');

    const partial = buildSingleJobSnapshot(workCwd, 'abcd');
    assert.equal(partial.job.id, 'abcd1234');

    const byIdx = buildSingleJobSnapshot(workCwd, '1');
    assert.equal(byIdx.job.id, 'abcd1234');
  });

  it('throws a helpful error when no job matches', () => {
    assert.throws(() => buildSingleJobSnapshot(workCwd, 'missing'), /No job found/);
  });

  it('keeps a summary containing a pipe and an embedded newline raw (F5) — escaping is a render-time concern, not the enriched/--json field', async () => {
    const job = await seedJob({ id: 'summary-escape', status: 'completed', summary: 'a | b\nc' });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.summary, 'a | b\nc');
  });

  it('enriches a running job with computed elapsed and reads tail of the log file', async () => {
    const created = new Date(Date.now() - 3000).toISOString();
    const job = await seedJob({
      id: 'enrich1',
      status: 'running',
      startedAt: created,
      lastProgressAt: new Date().toISOString(),
    });
    appendJobLog(workCwd, job.id, 'progress: line 1');
    appendJobLog(workCwd, job.id, 'progress: line 2');
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.ok(snap.job.elapsed, 'expected elapsed to be computed');
    assert.ok(Array.isArray(snap.job.recentProgress));
    assert.ok(snap.job.recentProgress.length >= 1);
  });
});

describe('classifyRuntimeHealth — branches via buildSingleJobSnapshot', () => {
  // R3: legacy jobs use startedAt until observations exist, with unchanged thresholds.
  for (const [ageSeconds, expected] of [[30, 'active'], [121, 'quiet'], [601, 'possibly_stalled']]) {
    it(`classifies a live legacy worker started ${ageSeconds} seconds ago as ${expected}`, async () => {
      const now = Date.UTC(2026, 0, 1, 12);
      const job = await seedJob({ status: 'running', pid: process.pid, startedAt: new Date(now - ageSeconds * 1000).toISOString() });
      const snapshot = buildSingleJobSnapshot(workCwd, job.id, { now });
      assert.equal(snapshot.job.healthStatus, expected);
    });
  }

  it('active when lastProgressAt is recent', async () => {
    const job = await seedJob({
      id: 'h-active',
      status: 'running',
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.healthStatus, 'active');
  });

  it('quiet when recent heartbeat but stale progress', async () => {
    const now = Date.now();
    const job = await seedJob({
      id: 'h-quiet',
      status: 'running',
      startedAt: new Date(now - QUIET_AFTER_MS * 2).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      lastProgressAt: new Date(now - QUIET_AFTER_MS - 30_000).toISOString(),
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id, { now });
    assert.equal(snap.job.healthStatus, 'quiet');
  });

  it('possibly_stalled when neither progress nor heartbeat are recent', async () => {
    const now = Date.now();
    const job = await seedJob({
      id: 'h-stall',
      status: 'running',
      startedAt: new Date(now - POSSIBLY_STALLED_AFTER_MS * 3).toISOString(),
      lastHeartbeatAt: new Date(now - POSSIBLY_STALLED_AFTER_MS * 2).toISOString(),
      lastProgressAt: new Date(now - POSSIBLY_STALLED_AFTER_MS * 2).toISOString(),
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id, { now });
    assert.equal(snap.job.healthStatus, 'possibly_stalled');
  });

  it('worker_missing when pid is dead (via injected isProcessAlive)', async () => {
    const job = await seedJob({ id: 'h-dead', status: 'running', pid: 12345 });
    const snap = buildSingleJobSnapshot(workCwd, job.id, { isProcessAlive: () => false });
    assert.equal(snap.job.healthStatus, 'worker_missing');
  });

  it('persisted auth_required survives reclassification', async () => {
    const job = await seedJob({
      id: 'h-auth',
      status: 'running',
      healthStatus: 'auth_required',
      healthMessage: 'auth pending',
    });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.healthStatus, 'auth_required');
  });

  it('terminal jobs get no classifier output', async () => {
    const job = await seedJob({ id: 'h-done', status: 'completed' });
    const snap = buildSingleJobSnapshot(workCwd, job.id);
    assert.equal(snap.job.healthStatus, null);
  });
});

describe('resolveResultJob', () => {
  it('returns the most recent terminal job when no reference is given', async () => {
    await seedJob({ id: 'r-done', status: 'completed', updatedAt: '2024-01-02T00:00:00Z' });
    await seedJob({ id: 'r-run', status: 'running', updatedAt: '2024-01-03T00:00:00Z' });
    const { job } = resolveResultJob(workCwd, null, process.env);
    assert.equal(job.id, 'r-done');
  });

  it('throws when the matched job is still running, suggesting --wait', async () => {
    await seedJob({ id: 'r-run-only', status: 'running' });
    assert.throws(() => resolveResultJob(workCwd, 'r-run-only', process.env), /still running/);
  });

  it('throws when nothing matches a reference', async () => {
    await seedJob({ id: 'x', status: 'completed' });
    assert.throws(() => resolveResultJob(workCwd, 'nothing', process.env), /No job found/);
  });

  it('throws when no finished jobs exist at all', () => {
    assert.throws(() => resolveResultJob(workCwd, null, process.env), /No finished/);
  });
});

describe('resolveCancelableJob', () => {
  it('returns the matching active job', async () => {
    await seedJob({ id: 'c1', status: 'running' });
    await seedJob({ id: 'c2', status: 'queued' });
    const { job } = resolveCancelableJob(workCwd, 'c1');
    assert.equal(job.id, 'c1');
  });

  it('errors when there are no active jobs', () => {
    assert.throws(() => resolveCancelableJob(workCwd, null), /No active antigravity jobs/);
  });

  it('errors when reference does not match any active job', async () => {
    await seedJob({ id: 'c3', status: 'running' });
    assert.throws(() => resolveCancelableJob(workCwd, 'unknown'), /No active job matched/);
  });
});
