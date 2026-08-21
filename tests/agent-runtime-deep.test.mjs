/**
 * Deeper tests for scripts/lib/agent-runtime.mjs.
 *
 * We replace the `agy` binary with a small fake binary (see
 * tests/helpers/fake-agy.mjs — a `#!/bin/sh` script on POSIX, a compiled
 * native stub on Windows, since `spawn()` cannot run a shell script or a
 * `.cmd`/`.bat` file directly there), so we can deterministically control
 * stdout, stderr, exit code, and timing without ever invoking the real CLI.
 *
 * Each test writes a one-shot stub and points runAgyPrint / probeAgy at it
 * via the `bin` option.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveAgyBin,
  probeAgy,
  runAgyPrint,
  spawnAgyDetached,
  DEFAULT_AGY_BIN,
} from '../scripts/lib/agent-runtime.mjs';
import { writeFakeAgy } from './helpers/fake-agy.mjs';

const TMPROOT = os.tmpdir();
let stubDir;

before(() => {
  stubDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-ar-'));
});

after(() => {
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
});

// Only used by the resolveAgyBin describe block below, which never spawns
// the file it writes — it just checks path resolution via existsSync, so
// the old POSIX-only shape is still fine there.
function writeStub(name, scriptBody) {
  const p = path.join(stubDir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
  return p;
}

describe('resolveAgyBin', () => {
  it('prefers $AGY_BIN when set and the path exists', () => {
    assert.equal(resolveAgyBin({ AGY_BIN: process.execPath, PATH: '' }), process.execPath);
  });

  it('falls back to scanning PATH', () => {
    const bin = writeStub('agy', 'echo agy 1.0.0');
    assert.equal(resolveAgyBin({ PATH: stubDir }), bin);
  });

  it('falls back to ~/.local/bin/agy when nothing else resolves', () => {
    const fakeHome = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-home-'));
    try {
      const localBin = path.join(fakeHome, '.local', 'bin');
      fs.mkdirSync(localBin, { recursive: true });
      const agy = path.join(localBin, 'agy');
      fs.writeFileSync(agy, '#!/bin/sh\necho fake\n', { mode: 0o755 });
      assert.equal(resolveAgyBin({ PATH: '/missing', HOME: fakeHome }), agy);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('uses Windows-style env.Path when env.PATH is absent', () => {
    const bin = writeStub('agy-win', 'echo win'); // separate file so we can write a unique fake
    // The resolver looks for the literal name "agy"; provide it.
    fs.writeFileSync(path.join(stubDir, 'agy'), '#!/bin/sh\necho via-Path\n', { mode: 0o755 });
    const found = resolveAgyBin({ Path: stubDir, HOME: '/no' });
    assert.equal(path.basename(found), 'agy');
  });

  it('returns DEFAULT_AGY_BIN when nothing resolves', () => {
    assert.equal(resolveAgyBin({ PATH: '/no/such', HOME: '/no/such' }), DEFAULT_AGY_BIN);
  });
});

describe('probeAgy', () => {
  it('returns ok with version on success', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-ver', { stdout: '1.2.3' });
    const out = await probeAgy({ bin });
    assert.equal(out.ok, true);
    assert.equal(out.version, '1.2.3');
  });

  it('returns ok=false with reason on non-zero exit', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-fail', { exitCode: 7 });
    const out = await probeAgy({ bin });
    assert.equal(out.ok, false);
    assert.match(out.reason, /exit 7/);
  });

  it('returns not-installed when bin is missing (ENOENT)', async () => {
    const out = await probeAgy({ bin: '/definitely/not/here/agy' });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not-installed');
  });

  it('returns timeout when the binary stalls', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-slow', { delayMs: 5000 });
    const out = await probeAgy({ bin, timeoutMs: 80 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'timeout');
  });
});

describe('runAgyPrint', () => {
  it('throws TypeError when prompt is missing', async () => {
    await assert.rejects(runAgyPrint({}), /non-empty string/);
  });

  it('throws TypeError when mode=conversation and conversationId is missing', async () => {
    await assert.rejects(
      runAgyPrint({ prompt: 'hi', mode: 'conversation' }),
      /conversationId required/
    );
  });

  it('captures stdout + stderr and reports completed', async () => {
    // Stub ignores args; emits a stream-json result line + stderr text; exits 0.
    const bin = writeFakeAgy(stubDir, 'agy-ok', {
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":"hello-out","conversation_id":"c1"}}',
      stderr: 'hello-err',
    });
    const out = await runAgyPrint({ prompt: 'go', bin });
    assert.equal(out.status, 'completed');
    assert.match(out.stdout, /hello-out/);
    assert.match(out.stderr, /hello-err/);
    assert.equal(out.exitCode, 0);
    assert.equal(out.agyConversationId, 'c1');
  });

  it('flags auth_required when the OAuth URL is in stdout', async () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?token=abc';
    // A small delay lets the stdout 'data' event fire before 'exit' resolves.
    const bin = writeFakeAgy(stubDir, 'agy-auth-url', { stdout: url, delayMs: 50 });
    const out = await runAgyPrint({ prompt: 'go', bin });
    assert.equal(out.status, 'auth_required');
    assert.equal(out.oauthUrl, url);
  });

  it('flags auth_required when stdout starts with the sentinel line', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-auth-line', {
      stdout: 'Authentication required. Please visit the URL to log in',
      delayMs: 50,
    });
    const out = await runAgyPrint({ prompt: 'go', bin });
    assert.equal(out.status, 'auth_required');
  });

  it('flags failed on non-zero exit without an OAuth URL', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-bad', { stderr: 'err', exitCode: 3 });
    const out = await runAgyPrint({ prompt: 'go', bin });
    assert.equal(out.status, 'failed');
    assert.equal(out.exitCode, 3);
  });

  it('flags timeout when the child outlives timeoutMs', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-stall', { delayMs: 5000 });
    const out = await runAgyPrint({ prompt: 'go', bin, timeoutMs: 80 });
    assert.equal(out.status, 'timeout');
  });

  it('honors an AbortSignal and reports cancelled', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-cancel', { delayMs: 2000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const out = await runAgyPrint({ prompt: 'go', bin, signal: ac.signal });
    assert.equal(out.status, 'cancelled');
  });

  it('reports cancelled when the AbortSignal was already aborted', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-already-cancelled', { delayMs: 2000 });
    const ac = new AbortController();
    ac.abort();
    const out = await runAgyPrint({ prompt: 'go', bin, signal: ac.signal });
    assert.equal(out.status, 'cancelled');
  });

  it('forwards onStdout / onStderr callbacks', async () => {
    const bin = writeFakeAgy(stubDir, 'agy-cb', { stdout: 'o', stderr: 'e' });
    const seenOut = [];
    const seenErr = [];
    await runAgyPrint({
      prompt: 'go', bin,
      onStdout: (c) => seenOut.push(c),
      onStderr: (c) => seenErr.push(c),
    });
    assert.match(seenOut.join(''), /o/);
    assert.match(seenErr.join(''), /e/);
  });

  it('reports failed with stderr context when the bin path does not exist', async () => {
    const out = await runAgyPrint({ prompt: 'go', bin: '/no/such/path/agy' });
    assert.equal(out.status, 'failed');
    assert.match(out.stderr, /spawn error/);
  });

  it('appends --continue / --conversation / --add-dir flags', async () => {
    // The stub prints its argv to stdout so we can inspect it. No result
    // event is emitted, so runAgyPrint falls back to the raw argv-echo text
    // as `stdout` (sawResult stays false) — exactly what these assertions read.
    const bin = writeFakeAgy(stubDir, 'agy-args', { echoArgs: true, delayMs: 50 });

    const cont = await runAgyPrint({ prompt: 'p1', mode: 'continue', bin });
    assert.match(cont.stdout, /arg=--continue/);
    assert.match(cont.stdout, /arg=--input-format/);
    assert.match(cont.stdout, /arg=stream-json/);
    assert.match(cont.stdout, /arg=--print/);
    assert.doesNotMatch(cont.stdout, /arg=p1$/m);

    const conv = await runAgyPrint({
      prompt: 'p2',
      mode: 'conversation',
      conversationId: 'thr_42',
      addDirs: ['/extra'],
      bin,
    });
    assert.match(conv.stdout, /arg=--conversation/);
    assert.match(conv.stdout, /arg=thr_42/);
    assert.match(conv.stdout, /arg=--add-dir/);
    assert.match(conv.stdout, /arg=\/extra/);
    assert.doesNotMatch(conv.stdout, /arg=p2$/m);
  });
});

describe('spawnAgyDetached', () => {
  it('returns a child process and supports continue/conversation modes', () => {
    const bin = writeFakeAgy(stubDir, 'agy-detached', {});
    const c1 = spawnAgyDetached({ prompt: 'p', bin });
    assert.ok(c1.pid);
    c1.unref?.();

    const c2 = spawnAgyDetached({ prompt: 'p', mode: 'continue', bin });
    assert.ok(c2.pid);
    c2.unref?.();

    const c3 = spawnAgyDetached({ prompt: 'p', mode: 'conversation', conversationId: 'x', addDirs: ['/d'], bin });
    assert.ok(c3.pid);
    c3.unref?.();
  });

  it('throws when conversation mode lacks an id', () => {
    assert.throws(() => spawnAgyDetached({ prompt: 'p', mode: 'conversation' }), /conversationId required/);
  });
});
