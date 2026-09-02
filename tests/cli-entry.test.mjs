/**
 * Tests for scripts/lib/cli-entry.mjs — the direct-execution guard.
 *
 * Covers both ends of the regression this closes:
 *   - `node scripts/commands/<verb>.mjs ...` (the shape every Claude Code
 *     `/antigravity:*` surface uses) must actually call `run()` and exit
 *     with its code, instead of silently exiting 0 with no output.
 *   - `import()`ing a command module (bin/antigravity.mjs's own dispatch
 *     path) must NOT trigger `run()` as a side effect of the import.
 *
 * Never spawns the real `agy` binary; the spawned scenarios below only hit
 * command modules whose failure/status paths don't need it (missing args,
 * missing file, disk-only status read).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VISION = path.resolve(REPO_ROOT, 'scripts', 'commands', 'vision.mjs');
const STATUS = path.resolve(REPO_ROOT, 'scripts', 'commands', 'status.mjs');
const BIN = path.resolve(REPO_ROOT, 'bin', 'antigravity.mjs');

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', cwd });
}

describe('direct invocation of command modules (Claude Code /antigravity:* shape)', () => {
  let tmpCwd;
  before(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-cli-entry-'));
  });
  after(() => {
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('(a) vision.mjs with no args: nonzero exit and non-empty stderr — previously exit 0 / silent', () => {
    const res = runNode([VISION], tmpCwd);
    assert.notEqual(res.status, 0, `expected nonzero exit, got ${res.status}`);
    assert.ok(res.stderr.trim().length > 0, 'expected non-empty stderr');
  });

  it('(b) vision.mjs with a missing image path: nonzero exit, stderr names the path', () => {
    const missing = path.join(tmpCwd, 'definitely', 'missing.png');
    const res = runNode([VISION, missing], tmpCwd);
    assert.notEqual(res.status, 0, `expected nonzero exit, got ${res.status}`);
    assert.match(res.stderr, /image file not found/);
    assert.ok(res.stderr.includes('missing.png'), `expected stderr to name the path, got: ${res.stderr}`);
  });

  it('(c) status.mjs in a temp cwd: exit 0 and non-empty stdout (disk-only, no agy)', () => {
    const res = runNode([STATUS], tmpCwd);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.ok(res.stdout.trim().length > 0, 'expected non-empty stdout');
  });

  it('bin/antigravity.mjs status still works (import must not double-invoke run)', () => {
    const res = runNode([BIN, 'status'], tmpCwd);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.ok(res.stdout.trim().length > 0, 'expected non-empty stdout');
  });
});

describe('runIfMain (unit)', () => {
  it('(d) returns false and does not call run when importMetaUrl is not the entrypoint', async () => {
    const { runIfMain } = await import('../scripts/lib/cli-entry.mjs');
    const fakeRun = mock.fn(async () => 0);

    const otherFileUrl = pathToFileURL(path.join(os.tmpdir(), 'not-the-entrypoint.mjs')).href;
    const result = await runIfMain(otherFileUrl, fakeRun);

    assert.equal(result, false);
    assert.equal(fakeRun.mock.callCount(), 0);
  });

  it(
    '(e) Windows: case and slash differences in the same path are still the same entrypoint',
    { skip: process.platform !== 'win32' },
    async () => {
      const { runIfMain } = await import('../scripts/lib/cli-entry.mjs');

      const originalArgv1 = process.argv[1];
      const originalExit = process.exit;
      let capturedExitCode;
      process.exit = (code) => {
        capturedExitCode = code;
      };

      try {
        const fakeRun = mock.fn(async () => 7);
        // Same file, but forward slashes and flipped case on the drive
        // letter and directory names — NTFS comparison is case-insensitive.
        process.argv[1] = 'C:\\Users\\Asus\\fake\\module.mjs';
        const importMetaUrl = 'file:///c:/users/ASUS/FAKE/Module.MJS';

        const result = await runIfMain(importMetaUrl, fakeRun);

        assert.equal(result, true);
        assert.equal(fakeRun.mock.callCount(), 1);
        assert.equal(capturedExitCode, 7);
      } finally {
        process.argv[1] = originalArgv1;
        process.exit = originalExit;
      }
    },
  );

  it(
    '(e) POSIX: an identical path spelling is the same entrypoint',
    { skip: process.platform === 'win32' },
    async () => {
      const { runIfMain } = await import('../scripts/lib/cli-entry.mjs');

      const originalArgv1 = process.argv[1];
      const originalExit = process.exit;
      let capturedExitCode;
      process.exit = (code) => {
        capturedExitCode = code;
      };

      try {
        const fakeRun = mock.fn(async () => 7);
        process.argv[1] = '/tmp/fake/module.mjs';
        const importMetaUrl = pathToFileURL('/tmp/fake/module.mjs').href;

        const result = await runIfMain(importMetaUrl, fakeRun);

        assert.equal(result, true);
        assert.equal(fakeRun.mock.callCount(), 1);
        assert.equal(capturedExitCode, 7);
      } finally {
        process.argv[1] = originalArgv1;
        process.exit = originalExit;
      }
    },
  );

  it(
    '(e2) Windows: mixed case in the import URL still matches argv[1]',
    { skip: process.platform !== 'win32' },
    async () => {
      const { runIfMain } = await import('../scripts/lib/cli-entry.mjs');

      const originalArgv1 = process.argv[1];
      const originalExit = process.exit;
      let capturedExitCode;
      process.exit = (code) => {
        capturedExitCode = code;
      };

      try {
        const fakeRun = mock.fn(async () => 7);
        process.argv[1] = 'C:\\Users\\Asus\\fake\\module.mjs';
        const importMetaUrl = 'file:///C:/Users/Asus/fake/MODULE.mjs';

        const result = await runIfMain(importMetaUrl, fakeRun);

        assert.equal(result, true);
        assert.equal(fakeRun.mock.callCount(), 1);
        assert.equal(capturedExitCode, 7);
      } finally {
        process.argv[1] = originalArgv1;
        process.exit = originalExit;
      }
    },
  );

  it(
    '(e2) POSIX: a differently-cased path is a different entrypoint',
    { skip: process.platform === 'win32' },
    async () => {
      const { runIfMain } = await import('../scripts/lib/cli-entry.mjs');

      const originalArgv1 = process.argv[1];
      const originalExit = process.exit;
      let capturedExitCode;
      process.exit = (code) => {
        capturedExitCode = code;
      };

      try {
        const fakeRun = mock.fn(async () => 7);
        process.argv[1] = '/tmp/fake/module.mjs';
        const importMetaUrl = pathToFileURL('/tmp/FAKE/module.mjs').href;

        const result = await runIfMain(importMetaUrl, fakeRun);

        assert.equal(result, false);
        assert.equal(fakeRun.mock.callCount(), 0);
        assert.equal(capturedExitCode, undefined);
      } finally {
        process.argv[1] = originalArgv1;
        process.exit = originalExit;
      }
    },
  );

  it('propagates a run() error to stderr and exits 1', async () => {
    const { runIfMain } = await import('../scripts/lib/cli-entry.mjs');

    const originalArgv1 = process.argv[1];
    const originalExit = process.exit;
    const originalStderrWrite = process.stderr.write;
    let capturedExitCode;
    let stderrOutput = '';
    process.exit = (code) => {
      capturedExitCode = code;
    };
    process.stderr.write = (chunk) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    process.argv[1] = 'C:\\Users\\Asus\\fake\\failing-module.mjs';

    try {
      const failingRun = mock.fn(async () => {
        throw new Error('boom');
      });
      const importMetaUrl = pathToFileURL(process.argv[1]).href;

      const result = await runIfMain(importMetaUrl, failingRun);

      assert.equal(result, true);
      assert.equal(capturedExitCode, 1);
      assert.match(stderrOutput, /boom/);
    } finally {
      process.argv[1] = originalArgv1;
      process.exit = originalExit;
      process.stderr.write = originalStderrWrite;
    }
  });
});
