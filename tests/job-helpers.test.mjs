/**
 * Tests for scripts/lib/job-helpers.mjs.
 *
 * Replaces `agent-runtime` exports and the owned `process-adapter.mjs`
 * spawn seam with mutable test doubles installed via node:test's
 * experimental module mocking. A single mock is installed and the
 * underlying behaviour is
 * swapped via a shared `state` object, so all tests share the same
 * cached job-helpers module — that keeps the V8 coverage report
 * accurate (one module instance, one tally).
 *
 *   node --test --experimental-test-module-mocks tests/job-helpers.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { portableTmpRoot } from './helpers/tmp.mjs';
import { SESSION_ID_ENV } from '../scripts/lib/job-control.mjs';

const TMPROOT = portableTmpRoot();

/** Mutable state that the mocks read on each invocation. */
const runtime = {
  next: { status: 'completed', exitCode: 0, stdout: '', stderr: '' },
  throws: null,
  spawnPid: 4242,
};

mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async () => {
      if (runtime.throws) throw runtime.throws;
      return { ...runtime.next };
    },
    spawnAgyDetached: () => ({ pid: runtime.spawnPid }),
    resolveAgyBin: () => 'agy',
    DEFAULT_AGY_BIN: 'agy',
  },
});

mock.module('../scripts/lib/process-adapter.mjs', {
  namedExports: {
    spawn: () => ({
      pid: runtime.spawnPid,
      unref() {},
      on() {},
    }),
  },
});

// Now the mocked modules are installed in the loader's cache; importing
// job-helpers below will pick them up.
const {
  runForegroundJob, startBackgroundJob, createTrackedJob, patchJob, waitForJob, newJobId, currentSessionId,
  resolveWorkerPath,
} = await import('../scripts/lib/job-helpers.mjs');
const { readJobFile, listJobs } = await import('../scripts/lib/state.mjs');

let workspaceRoot;
const tmpToCleanup = [];

function freshWorkspace() {
  const dir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jh-'));
  const data = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-jh-data-'));
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env[SESSION_ID_ENV] = 'sess-' + randomBytes(2).toString('hex');
  tmpToCleanup.push(dir, data);
  workspaceRoot = dir;
  return dir;
}

after(() => {
  for (const p of tmpToCleanup) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env[SESSION_ID_ENV];
});

describe('runForegroundJob — terminal status mapping', () => {
  it('completed → status=completed, summary derived from stdout first line', async () => {
    freshWorkspace();
    runtime.throws = null;
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'final answer\nmore', stderr: '' };
    const { job, result } = await runForegroundJob({
      workspaceRoot, kind: 'task', title: 'demo', prompt: 'hi',
    });
    assert.equal(result.status, 'completed');
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'completed');
    assert.equal(stored.summary, 'final answer');
    assert.equal(stored.exitCode, 0);
  });

  it('completed with very long first line → summary is truncated', async () => {
    freshWorkspace();
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'x'.repeat(200), stderr: '' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 't', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.summary.length, 120);
    assert.ok(stored.summary.endsWith('...'));
  });

  it('completed with empty stdout → summary is null', async () => {
    freshWorkspace();
    runtime.next = { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 't', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.summary, null);
  });

  it('auth_required → failed + healthStatus=auth_required + OAuth URL', async () => {
    freshWorkspace();
    runtime.next = {
      status: 'auth_required', exitCode: 1, stdout: '', stderr: 'oauth',
      oauthUrl: 'https://example/oauth',
    };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.healthStatus, 'auth_required');
    assert.equal(stored.oauthUrl, 'https://example/oauth');
    assert.match(stored.healthMessage, /not authenticated/);
    assert.match(stored.recommendedAction, /setup/);
  });

  it('timeout → failed with retry hint', async () => {
    freshWorkspace();
    runtime.next = { status: 'timeout', exitCode: 124, stdout: '', stderr: 'slow' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.match(stored.healthMessage, /timed out/);
    assert.match(stored.recommendedAction, /background/);
  });

  it('cancelled → status=cancelled', async () => {
    freshWorkspace();
    runtime.next = { status: 'cancelled', exitCode: 130, stdout: '', stderr: '' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    assert.equal(readJobFile(workspaceRoot, job.id).status, 'cancelled');
  });

  it('failed → status=failed and errorMessage from stderr', async () => {
    freshWorkspace();
    runtime.next = { status: 'failed', exitCode: 1, stdout: '', stderr: '  err\n' };
    const { job } = await runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.equal(stored.errorMessage, 'err');
  });

  it('thrown runAgyPrint → propagates and marks job failed', async () => {
    freshWorkspace();
    runtime.throws = new Error('boom');
    await assert.rejects(
      runForegroundJob({ workspaceRoot, kind: 'task', title: 'x', prompt: 'p' }),
      /boom/
    );
    runtime.throws = null;
    // Find the failed job on disk.
    const jobs = listJobs(workspaceRoot);
    assert.ok(jobs.length >= 1);
    const stored = readJobFile(workspaceRoot, jobs[jobs.length - 1].id);
    assert.equal(stored.status, 'failed');
    assert.match(stored.errorMessage, /boom/);
  });
});

describe('startBackgroundJob + patchJob + waitForJob + newJobId', () => {
  it('startBackgroundJob records the spawned pid', async () => {
    freshWorkspace();
    runtime.spawnPid = 5555;
    const { job, pid } = await startBackgroundJob({
      workspaceRoot, kind: 'task', title: 'bg', prompt: 'do',
    });
    assert.equal(pid, 5555);
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.pid, 5555);
    assert.equal(stored.workerPid, 5555);
    assert.equal(stored.kind, 'task');
    // The background request payload is persisted.
    assert.equal(stored.request.prompt, 'do');
  });

  it('patchJob merges + strips detail fields from the index', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'p' });
    await patchJob(workspaceRoot, job.id, {
      status: 'running',
      request: { p: 1 },
      result: { x: 1 },
      stdout: 'unused',
    });
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'running');
    assert.deepEqual(stored.request, { p: 1 });
    const indexEntry = listJobs(workspaceRoot).find((j) => j.id === job.id);
    assert.equal(indexEntry.request, undefined);
    assert.equal(indexEntry.result, undefined);
    assert.equal(indexEntry.stdout, undefined);
  });

  it('patchJob on an unknown id creates a fresh record', async () => {
    freshWorkspace();
    await patchJob(workspaceRoot, 'fresh-id', { status: 'completed' });
    const stored = readJobFile(workspaceRoot, 'fresh-id');
    assert.equal(stored.id, 'fresh-id');
    assert.equal(stored.status, 'completed');
  });

  it('waitForJob returns the terminal record promptly when status flips', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'w' });
    // Deterministic signal instead of a real-timer race: the status flip
    // happens on a specific poll iteration rather than "whichever timer
    // wins", so the assertion below proves waitForJob picked it up on the
    // very next poll rather than merely eventually noticing it.
    let pollCount = 0;
    const finalJob = await waitForJob(workspaceRoot, job.id, {
      pollMs: 15,
      timeoutMs: 2000,
      sleep: async () => {
        pollCount += 1;
        if (pollCount === 1) await patchJob(workspaceRoot, job.id, { status: 'completed' });
      },
    });
    assert.equal(finalJob.status, 'completed');
    assert.equal(pollCount, 1);
  });

  it('waitForJob returns the latest (still-queued) snapshot when the deadline elapses', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'w2' });
    // Injected clock: the deadline elapses on the first simulated tick, with
    // zero real wall-clock time spent and no reliance on system timer
    // granularity. Nothing ever patches the job, so the only reachable
    // outcome is the still-queued snapshot — assert it exactly instead of
    // the previously permissive "null or queued" check.
    let clock = 0;
    const finalJob = await waitForJob(workspaceRoot, job.id, {
      pollMs: 20,
      timeoutMs: 80,
      now: () => clock,
      sleep: async () => { clock += 100; },
    });
    assert.equal(finalJob.status, 'queued');
  });

  it('waitForJob marks a vanished worker terminal instead of hanging', async () => {
    freshWorkspace();
    const job = await createTrackedJob({ workspaceRoot, kind: 'task', title: 'gone' });
    await patchJob(workspaceRoot, job.id, { status: 'running', workerPid: 909090, pid: 909090 });
    const finalJob = await waitForJob(workspaceRoot, job.id, {
      pollMs: 5,
      timeoutMs: 2000,
      isProcessAlive: () => false,
    });
    assert.equal(finalJob.status, 'failed');
    assert.equal(finalJob.phase, 'worker_missing');
    assert.match(finalJob.errorMessage, /no longer running/);
  });

  it('newJobId returns unique 12-char ids; currentSessionId reads SESSION_ID_ENV', () => {
    const a = newJobId(), b = newJobId();
    assert.notEqual(a, b);
    assert.equal(a.length, 12);
    assert.equal(currentSessionId({ [SESSION_ID_ENV]: 'sess' }), 'sess');
    assert.equal(currentSessionId({}), null);
  });
});

describe('resolveWorkerPath', () => {
  it('resolves to an absolute OS path that exists on disk (fileURLToPath, not URL.pathname)', () => {
    // Regression: `new URL(...).pathname` on Windows yields a POSIX-shaped
    // path (`/A:/projects-vault/...`) that fs.existsSync reports as false —
    // the worker would die MODULE_NOT_FOUND under stdio:'ignore', silently
    // stuck `queued` forever. This assertion is red on Windows against the
    // old `.pathname`-based implementation.
    const p = resolveWorkerPath();
    assert.equal(path.isAbsolute(p), true);
    assert.equal(fs.existsSync(p), true);
    assert.equal(path.basename(p), '_worker.mjs');
  });
});
