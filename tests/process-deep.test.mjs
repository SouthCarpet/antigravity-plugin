/**
 * Deep tests for scripts/lib/process.mjs covering terminateProcessTree,
 * binaryAvailable, and spawnDetached. Uses short-lived `sleep` children so
 * the suite stays well within the 30-second budget.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  binaryAvailable,
  terminateProcessTree,
  spawnDetached,
} from '../scripts/lib/process.mjs';

const TMPROOT = os.tmpdir();

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

// A binary that exists on PATH in EVERY environment this suite runs in:
// `sh` is absent from a plain PowerShell PATH on Windows, so these tests
// must not assume it (they passed or failed depending on which shell ran
// them — the exact environment-dependence issue #3 was about).
const SHELL_BIN = process.platform === 'win32' ? 'cmd' : 'sh';

describe('binaryAvailable', () => {
  it(`returns true for an executable that exists on PATH (${SHELL_BIN})`, () => {
    assert.equal(binaryAvailable(SHELL_BIN), true);
  });

  it('returns false for a binary that does not exist', () => {
    assert.equal(binaryAvailable('definitely-not-a-real-binary-xyz'), false);
  });
});

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

/**
 * spawnDetached() unrefs the child so a fire-and-forget worker does not keep
 * the parent event loop alive. node:test treats a Promise that outlives the
 * loop as cancelledByParent. Re-ref and wait for the real `exit`/`error`
 * signal — never a timeout.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null }>}
 */
function waitForExit(child) {
  if (typeof child.ref === 'function') child.ref();
  return new Promise((resolve, reject) => {
    const done = (code, signal) => resolve({ code, signal });
    if (child.exitCode !== null || child.signalCode !== null) {
      done(child.exitCode, child.signalCode);
      return;
    }
    child.once('exit', done);
    child.once('error', reject);
  });
}

describe('spawnDetached', () => {
  it('spawns with stdio=ignore and unrefs when no log file is provided', async () => {
    const child = spawnDetached(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(child.pid);
    await waitForExit(child);
  });

  it('redirects stderr to a log file when logFile is provided', async () => {
    const dir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-spawn-'));
    const log = path.join(dir, 'out.log');
    // spawnDetached inherits its stderr fd straight into the child (no
    // shell involved) — that works for a genuine native executable, but
    // Git-for-Windows' `sh.exe` re-execs through its own MSYS runtime and
    // the inherited fd does not survive that hop, so on win32 this uses
    // cmd.exe (a real, directly-spawnable PE binary) instead of sh.
    const [command, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'echo line-to-stderr 1>&2']]
      : ['sh', ['-c', 'echo line-to-stderr 1>&2; exit 0']];
    try {
      const child = spawnDetached(command, args, { logFile: log });
      assert.ok(child.pid);
      await waitForExit(child);
      const body = fs.readFileSync(log, 'utf8');
      assert.match(body, /line-to-stderr/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
