/**
 * Deep tests for scripts/lib/process.mjs covering terminateProcessTree. Uses
 * short-lived `sleep` children so the suite stays well within the 30-second
 * budget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import {
  terminateProcessTree,
  runCommand,
  isProcessAlive,
  processStartedAt,
} from '../scripts/lib/process.mjs';

it('treats an EPERM probe as an existing process, as required by R3', () => {
  assert.equal(isProcessAlive(123, () => { throw Object.assign(new Error('not ours'), { code: 'EPERM' }); }), true);
  assert.equal(isProcessAlive(123, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }), false);
});

it('can read the start time of a live child for stale-lock identity checks', async () => {
  const earliest = Date.now() - 3000;
  const child = spawn(process.execPath, ['-e', 'process.send("ready"); process.on("message", () => process.exit(0));'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    const queryStartedAt = Date.now();
    const startedAt = processStartedAt(child.pid, { queryTimeoutMs: 20_000 });
    const queryElapsedMs = Date.now() - queryStartedAt;
    // Window is 3 s on each side: POSIX ps derives lstart from the boot time
    // in /proc/stat plus start ticks at second resolution, so the reported
    // value can land about a second either side of the wall clock.
    const latest = Date.now() + 3000;
    assert.ok(startedAt !== null, `start time query on ${process.platform} returned null after ${queryElapsedMs} ms`);
    assert.ok(startedAt >= earliest && startedAt <= latest, `start time: ${startedAt}, earliest: ${earliest}, latest: ${latest}`);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.send('exit');
    await exited;
  }
});

it('caches a process start query during retries and refreshes it after five seconds', () => {
  // Oracle: fix brief F1 requires no shell per stale-lock retry while later
  // PID reuse must still become observable after the bounded cache expires.
  let now = 0;
  let calls = 0;
  let stdout = '2026-09-05T12:00:00.000Z';
  const spawnSyncImpl = () => {
    calls += 1;
    return { status: 0, error: null, stdout };
  };
  const options = { now: () => now, platform: 'win32', spawnSyncImpl };

  const first = processStartedAt(3_145_729, options);
  now = 4_999;
  const cached = processStartedAt(3_145_729, options);
  stdout = '2026-09-05T12:01:00.000Z';
  now = 5_000;
  const refreshed = processStartedAt(3_145_729, options);

  assert.equal(calls, 2);
  assert.equal(cached, first);
  assert.notEqual(refreshed, first);
});

it('caches a null result (query failure or timeout) for the same TTL as a real value', () => {
  // Oracle: fix brief 076-T4-fix2 F2. A null is conservative for stale-lock
  // logic (staleLockCanBeReaped treats it as "cannot conclude dead, do not
  // reap"), but the 5 s TTL was written to also cover a real value; this
  // pins that a query failure is cached the same way, not re-queried on
  // every retry, and still expires like a real value would.
  let now = 100_000;
  let calls = 0;
  const spawnSyncImpl = () => {
    calls += 1;
    return { status: 1, error: null, stdout: '' };
  };
  const options = { now: () => now, platform: 'win32', spawnSyncImpl };

  const first = processStartedAt(9_999_991, options);
  now = 104_999;
  const cachedNull = processStartedAt(9_999_991, options);
  now = 105_000;
  const requeried = processStartedAt(9_999_991, options);

  assert.equal(first, null);
  assert.equal(cachedNull, null);
  assert.equal(requeried, null);
  assert.equal(calls, 2, 'the cached null must not trigger a second spawn inside the TTL window');
});

it('returns a one-line timeout error for a child sleeping beyond an injected 50 ms bound', () => {
  // Oracle: brief 076-T3 R1. The real synchronous child would run for 2 s.
  const result = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { timeoutMs: 50 });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.error?.message, `${process.execPath} timed out after 50 ms`);
});

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone from the OS, or `timeoutMs` elapses. */
function waitUntilPidGone(pid, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!pidExists(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Named cases, generated once at module scope — each becomes its own `it`. */
const INVALID_PIDS = [
  { label: 'zero', pid: 0 },
  { label: 'negative', pid: -1 },
  { label: 'NaN', pid: NaN },
  { label: 'undefined', pid: undefined },
];

describe('terminateProcessTree', () => {
  for (const { label, pid } of INVALID_PIDS) {
    it(`reports failed for an invalid pid (${label})`, async () => {
      assert.equal((await terminateProcessTree(pid)).outcome, 'failed');
    });
  }

  it('SIGTERMs a real child process group', async () => {
    // Launch a detached long-lived child. node itself is the one binary
    // guaranteed present (we are running under it) and spawns identically
    // on every platform — no shell needed.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore' });
    try {
      assert.ok(child.pid, 'child should have a pid');
      // Attach before kill so a fast taskkill cannot outrun the listener.
      const exitSeen = new Promise((resolve) => {
        child.once('exit', () => resolve(true));
      });
      const termination = terminateProcessTree(child.pid);
      const gone = await Promise.race([
        exitSeen,
        waitUntilPidGone(child.pid, 5000),
      ]);
      assert.equal(gone, true, 'child should have exited after SIGTERM');
      assert.equal((await termination).outcome, 'killed');
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  });

  it('reports not_found when the pid is already gone', async () => {
    // Pick a pid that will not exist. process.kill throws ESRCH internally
    // which the helper catches.
    assert.equal((await terminateProcessTree(2 ** 22)).outcome, 'not_found');
  });

  it('mocked taskkill: killed when the process exits after taskkill runs', async () => {
    let running = true;
    const result = await terminateProcessTree(101, {
      platform: 'win32',
      probe: () => running,
      spawnSyncImpl: () => { running = false; return { status: 0, stderr: '', signal: null }; },
      graceMs: 1,
    });
    assert.deepEqual(
      { outcome: result.outcome, killed: result.killed, status: result.status, attempt: result.attempts[0].kind },
      { outcome: 'killed', killed: true, status: 0, attempt: 'taskkill' },
    );
  });

  it('mocked taskkill: not_found when the probe reports the pid already gone', async () => {
    const result = await terminateProcessTree(102, { platform: 'win32', probe: () => false });
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.killed, false);
  });

  it('mocked taskkill: denied after two attempts on "Access is denied"', async () => {
    const result = await terminateProcessTree(103, {
      platform: 'win32', probe: () => true, graceMs: 1, forceGraceMs: 1,
      spawnSyncImpl: () => ({ status: 1, stderr: 'ERROR: Access is denied.', signal: null }),
    });
    assert.equal(result.outcome, 'denied');
    assert.equal(result.status, 1);
    assert.equal(result.attempts.length, 2);
  });

  it('mocked taskkill: failed on an unexpected non-zero exit', async () => {
    const result = await terminateProcessTree(104, {
      platform: 'win32', probe: () => true, graceMs: 1, forceGraceMs: 1,
      spawnSyncImpl: () => ({ status: 7, stderr: 'unexpected taskkill failure', signal: null }),
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.status, 7);
  });
});
