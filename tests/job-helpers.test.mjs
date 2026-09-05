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
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';
import { SESSION_ID_ENV } from '../scripts/lib/job-control.mjs';

const TMPROOT = portableTmpRoot();

/** Mutable state that the mocks read on each invocation. */
const runtime = {
  next: { status: 'completed', exitCode: 0, stdout: '', stderr: '' },
  throws: null,
  spawnPid: 4242,
  textDeltas: [],
};

mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (options) => {
      if (runtime.throws) throw runtime.throws;
      for (const delta of runtime.textDeltas) options.onText?.(delta);
      return { ...runtime.next };
    },
    spawnAgyDetached: () => ({ pid: runtime.spawnPid }),
    resolveAgyBin: () => 'agy',
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

mock.module('../scripts/lib/process-adapter.mjs', {
  namedExports: {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: runtime.spawnPid, unref() {} });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  },
});

// Now the mocked modules are installed in the loader's cache; importing
// job-helpers below will pick them up.
const {
  runForegroundJob, startBackgroundJob, createTrackedJob, patchJob, waitForJob, newJobId, currentSessionId,
  resolveWorkerPath, agyTimeoutMs, waitOutcomeLine,
} = await import('../scripts/lib/job-helpers.mjs');
const {
  createJobActivityRecorder,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MIN_GAP_MS,
} = await import('../scripts/lib/job-activity.mjs');
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
    removeTestDir(p);
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

  it('streamed foreground output records lastProgressAt and lastModelOutputAt', async () => {
    freshWorkspace();
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'done', stderr: '' };
    runtime.textDeltas = ['first delta', 'second delta'];
    try {
      const { job } = await runForegroundJob({
        workspaceRoot, kind: 'task', title: 'observed', prompt: 'p',
      });
      const stored = readJobFile(workspaceRoot, job.id);
      assert.ok(Number.isFinite(Date.parse(stored.lastProgressAt)));
      assert.equal(stored.lastModelOutputAt, stored.lastProgressAt);
    } finally {
      runtime.textDeltas = [];
    }
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

describe('observed job activity', () => {
  it('shares one five-second patch budget between output and heartbeat sources', async () => {
    let now = 0;
    let timerCallback;
    let clearedTimer = null;
    let unrefCalled = false;
    const patches = [];
    const timer = { unref: () => { unrefCalled = true; } };
    const activity = createJobActivityRecorder('workspace', 'job', {
      heartbeat: true,
      now: () => now,
      patch: async (_workspaceRoot, _jobId, fields) => { patches.push(fields); },
      setIntervalImpl: (callback, intervalMs) => {
        assert.equal(intervalMs, HEARTBEAT_INTERVAL_MS);
        timerCallback = callback;
        return timer;
      },
      clearIntervalImpl: (value) => { clearedTimer = value; },
    });

    activity.onText();
    activity.onText();
    await new Promise((resolve) => setImmediate(resolve));
    now = HEARTBEAT_MIN_GAP_MS - 1;
    activity.onText();
    timerCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(patches.length, 1);

    now = HEARTBEAT_MIN_GAP_MS;
    timerCallback();
    await activity.finish();

    assert.equal(patches.length, 2);
    assert.equal(patches[0].lastHeartbeatAt, '1970-01-01T00:00:00.000Z');
    assert.equal(patches[0].lastProgressAt, '1970-01-01T00:00:00.000Z');
    assert.equal(patches[0].lastModelOutputAt, patches[0].lastProgressAt);
    assert.equal(patches[1].lastHeartbeatAt, '1970-01-01T00:00:05.000Z');
    assert.equal(patches[1].lastProgressAt, '1970-01-01T00:00:04.999Z');
    assert.equal(unrefCalled, true);
    assert.equal(clearedTimer, timer);
  });

  it('describes timed-out and vanished wait outcomes exactly', () => {
    assert.equal(
      waitOutcomeLine('task', { id: 'abcdef123456', status: 'running' }),
      'antigravity:task — wait timed out; job abcdef123456 is still running. Run /antigravity:status abcdef123456.',
    );
    assert.equal(
      waitOutcomeLine('rescue', null),
      'antigravity:rescue — job record vanished while waiting.',
    );
    assert.equal(waitOutcomeLine('review', { id: 'abcdef123456', status: 'completed' }), null);
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

// Oracle: 076-T3 R1. Decimal safe millisecond integers up to the Node timer
// ceiling are accepted; invalid values warn once and retain the 30-minute default.
describe('agy execution budget environment', () => {
  const cases = [
    { value: undefined, expected: 1800000, warning: '' },
    { value: '0', expected: 0, warning: '' },
    { value: '1500', expected: 1500, warning: '' },
    { value: '2147483647', expected: 2147483647, warning: '' },
    { value: 'abc', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS=abc (not a positive integer of milliseconds)\n' },
    { value: '-5', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS=-5 (not a positive integer of milliseconds)\n' },
    { value: '1e12', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS=1e12 (not a positive integer of milliseconds)\n' },
    { value: '2147483648', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS=2147483648 (not a positive integer of milliseconds)\n' },
    { value: '', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS= (not a positive integer of milliseconds)\n' },
    { value: '1.5', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS=1.5 (not a positive integer of milliseconds)\n' },
    // Numeric to `Number()`, rejected by the decimal shape: without the regex
    // a hex literal and a padded value would silently become a budget.
    { value: '0x10', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS=0x10 (not a positive integer of milliseconds)\n' },
    { value: ' 5', expected: 1800000, warning: 'antigravity: ignoring ANTIGRAVITY_AGY_TIMEOUT_MS= 5 (not a positive integer of milliseconds)\n' },
  ];
  for (const { value, expected, warning } of cases) {
    it(`uses ${expected} ms for ${JSON.stringify(value)} and emits the specified warning`, (t) => {
      let stderr = '';
      t.mock.method(process.stderr, 'write', (chunk) => { stderr += chunk; return true; });
      assert.equal(agyTimeoutMs({ ANTIGRAVITY_AGY_TIMEOUT_MS: value }), expected);
      assert.equal(stderr, warning);
    });
  }
});

// Oracle: 076-T3 R3. Failure paths use owned child fakes or a real spawn
// with a deleted temporary cwd; none launches the actual worker.
describe('background worker acknowledgement', () => {
  it('waits for spawn before returning queued and persists the enqueue budget', async () => {
    freshWorkspace();
    const child = Object.assign(new EventEmitter(), { pid: 7331, unref() {} });
    let acknowledge;
    const launched = new Promise((resolve) => { acknowledge = resolve; });
    let returned = false;
    const pending = startBackgroundJob({
      workspaceRoot, kind: 'task', prompt: 'p',
      env: { ANTIGRAVITY_AGY_TIMEOUT_MS: '1500' },
      spawnWorker: () => { acknowledge(); return child; },
    }).then((result) => { returned = true; return result; });
    await launched;
    assert.equal(returned, false);
    child.emit('spawn');
    const { job } = await pending;
    assert.equal(job.status, 'queued');
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.workerPid, 7331);
    assert.equal(stored.request.timeoutMs, 1500);
    assert.doesNotThrow(() => child.emit('error', new Error('late handle error')));
  });

  it('persists failed when an owned child emits error asynchronously', async () => {
    freshWorkspace();
    const { job, pid } = await startBackgroundJob({
      workspaceRoot, kind: 'task', prompt: 'p',
      spawnWorker: () => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('error', new Error('creation denied')));
        return child;
      },
    });
    assert.equal(pid, null);
    assert.equal(job.status, 'failed');
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.phase, 'failed');
    assert.equal(stored.healthStatus, 'failed');
    assert.equal(stored.errorMessage, 'Worker launch failed: creation denied');
    assert.ok(stored.completedAt);
  });

  it('returns a persisted failure when the actual spawn cwd has been deleted', async () => {
    freshWorkspace();
    const deletedCwd = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-deleted-cwd-'));
    fs.rmdirSync(deletedCwd);
    const { job } = await startBackgroundJob({
      workspaceRoot, kind: 'task', prompt: 'p',
      spawnWorker: (command, args, options) => nodeSpawn(command, args, { ...options, cwd: deletedCwd }),
    });
    assert.equal(job.status, 'failed');
    const stored = readJobFile(workspaceRoot, job.id);
    assert.equal(stored.status, 'failed');
    assert.match(stored.errorMessage, /^Worker launch failed: spawn .* ENOENT$/);
  });

  it('terminates an acknowledged worker before returning a PID-patch failure', async () => {
    freshWorkspace();
    let alive = true;
    const { job } = await startBackgroundJob({
      workspaceRoot, kind: 'task', prompt: 'p',
      spawnWorker: () => {
        const child = Object.assign(new EventEmitter(), { pid: 7331, unref() {} });
        setImmediate(() => child.emit('spawn'));
        return child;
      },
      persistWorkerPid: async () => { throw new Error('PID write failed'); },
      terminateTree: async (pid) => { assert.equal(pid, 7331); alive = false; },
    });
    assert.equal(alive, false);
    assert.equal(job.status, 'failed');
    assert.equal(readJobFile(workspaceRoot, job.id).errorMessage, 'Worker launch failed: PID write failed');
  });
});

// The helper writes a job store on a real disk; its measured baseline on the
// reference machine is 5-6 s alone and grows under a loaded full-suite run,
// so the bound is that order plus a safety factor, not a tight 10 s.
const HELPER_TIMEOUT_MS = 30000;

describe('foreground runtime bounds integration', () => {
  // Oracle: 076-T3 R1. The helper uses a real sleeping Node child through the
  // owned adapter and verifies its PID is gone, without invoking taskkill.
  for (const mode of ['foreground', 'output-cap']) {
    it(`${mode} persists failed and leaves no fake agy process`, () => {
      freshWorkspace();
      const result = spawnSync(process.execPath, [
        '--experimental-test-module-mocks',
        path.join(import.meta.dirname, 'helpers', 'runtime-budget.mjs'), mode,
      ], { cwd: workspaceRoot, encoding: 'utf8', timeout: HELPER_TIMEOUT_MS, env: { ...process.env } });
      assert.equal(result.error?.code, undefined,
        `helper did not finish within ${HELPER_TIMEOUT_MS} ms: ${result.error?.message}`);
      assert.equal(result.status, 0, result.stderr);
    });
  }
});
