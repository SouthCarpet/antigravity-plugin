/**
 * POSIX-only trust checks for the shared-tmp state/lock root (item 15,
 * F4/F15). `assertPrivateDir` is a no-op on win32 — `%TEMP%` is per-user
 * there and Windows has no POSIX uid/mode model to check — so every case
 * here is skipped on this Windows machine and runs on CI's Ubuntu job.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertPrivateDir, UnsafeStateDirError } from '../scripts/lib/fs.mjs';
import { withFileLockSync } from '../scripts/lib/file-lock.mjs';
import { ensureStateDir } from '../scripts/lib/state.mjs';

const SKIP_REASON =
  'POSIX-only: assertPrivateDir no-ops on win32 (no uid/mode model to check); ' +
  "this case runs on CI's Ubuntu job.";
const SKIP = process.platform === 'win32' ? SKIP_REASON : false;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('assertPrivateDir', () => {
  it('throws on a pre-created 0o777 root, naming the fix', { skip: SKIP }, () => {
    const dir = tmpDir('antigravity-trust-777-');
    fs.chmodSync(dir, 0o777);
    assert.throws(
      () => assertPrivateDir(dir),
      (err) =>
        err instanceof UnsafeStateDirError &&
        err.message.includes(dir) &&
        /is not a private directory owned by this user/.test(err.message) &&
        /CLAUDE_PLUGIN_DATA/.test(err.message),
    );
  });

  it('accepts a 0o700 root owned by this user', { skip: SKIP }, () => {
    const dir = tmpDir('antigravity-trust-700-');
    fs.chmodSync(dir, 0o700);
    assert.doesNotThrow(() => assertPrivateDir(dir));
  });

  it('throws on a symlinked root', { skip: SKIP }, () => {
    const real = tmpDir('antigravity-trust-real-');
    const link = path.join(os.tmpdir(), `antigravity-trust-link-${process.pid}`);
    fs.symlinkSync(real, link);
    try {
      assert.throws(() => assertPrivateDir(link), UnsafeStateDirError);
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('is a no-op on win32', { skip: process.platform !== 'win32' ? 'win32-only case' : false }, () => {
    // No POSIX stat is performed at all on win32, so an otherwise-invalid
    // (non-existent) path never throws here.
    assert.doesNotThrow(() => assertPrivateDir(path.join(os.tmpdir(), 'does-not-exist-anywhere')));
  });
});

describe('file-lock root creation', () => {
  it('creates the lock root 0o700', { skip: SKIP }, () => {
    const base = tmpDir('antigravity-trust-lockbase-');
    const lockRoot = path.join(base, 'nested', 'locks');
    const lockPath = path.join(lockRoot, 'x.lock');
    withFileLockSync(lockPath, () => {});
    const mode = fs.statSync(lockRoot).mode & 0o777;
    assert.equal(mode, 0o700);
  });
});

describe('ensureStateDir wiring (F2/F7)', () => {
  // `mkdirSync({ recursive: true })` silently accepts a pre-existing
  // directory and only sets the mode of the level it actually creates, so a
  // check only on the `jobs` leaf never sees an attacker-planted state root
  // or per-workspace directory. This asserts the wiring, not just
  // `assertPrivateDir` in isolation: on win32 it is a no-op the same as
  // every other case here.
  it('throws when the state root is pre-created 0o777, before creating anything beneath it', { skip: SKIP }, () => {
    const dataDir = tmpDir('antigravity-trust-data-');
    const stateRoot = path.join(dataDir, 'state');
    fs.mkdirSync(stateRoot, { mode: 0o777 });
    const cwd = tmpDir('antigravity-trust-cwd-');
    const saved = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    try {
      assert.throws(
        () => ensureStateDir(cwd),
        (err) => err instanceof UnsafeStateDirError && err.message.includes(stateRoot),
      );
      assert.deepEqual(fs.readdirSync(stateRoot), [], 'nothing beneath the untrusted root should be created');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = saved;
    }
  });
});
