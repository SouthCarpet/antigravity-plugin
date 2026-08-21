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

describe('terminateProcessTree', () => {
  it('ignores invalid pids (≤0, NaN)', () => {
    // None of these should throw.
    terminateProcessTree(0);
    terminateProcessTree(-1);
    terminateProcessTree(NaN);
    terminateProcessTree(undefined);
  });

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
      terminateProcessTree(child.pid);
      const gone = await Promise.race([
        exitSeen,
        waitUntilPidGone(child.pid, 5000),
      ]);
      assert.equal(gone, true, 'child should have exited after SIGTERM');
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
  });

  it('silently absorbs ESRCH when the pid is already gone', () => {
    // Pick a pid that will not exist. process.kill throws ESRCH internally
    // which the helper catches.
    terminateProcessTree(2 ** 22);
  });
});

describe('spawnDetached', () => {
  it('spawns with stdio=ignore and unrefs when no log file is provided', () => {
    const child = spawnDetached(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(child.pid);
    // Wait for exit so the test does not leave a zombie.
    return new Promise((resolve) => child.on('exit', () => resolve()));
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
      await new Promise((resolve) => child.on('exit', () => resolve()));
      const body = fs.readFileSync(log, 'utf8');
      assert.match(body, /line-to-stderr/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
