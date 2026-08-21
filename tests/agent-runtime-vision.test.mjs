/**
 * Tests added for the vision work: resolveAgyBin platform-shaped resolution,
 * and runAgyPrint / spawnAgyDetached `model` + `extraArgs` spawn-arg
 * placement.
 *
 * `node:child_process.spawn` is mocked (installed before agent-runtime.mjs
 * is imported, following the pattern in tests/job-helpers.test.mjs) so no
 * real process is ever spawned; resolveAgyBin is a pure function and is
 * exercised directly against temp-dir fixtures built with `os.tmpdir()`
 * (portable — this suite must pass on both POSIX and Windows).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawnCalls = [];

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  // stream-json transport: runAgyPrint/spawnAgyDetached always write the
  // prompt to stdin — a fake child without one throws immediately.
  child.stdin = new EventEmitter();
  child.stdin.written = '';
  child.stdin.write = (chunk) => { child.stdin.written += chunk; return true; };
  child.stdin.end = () => {};
  return child;
}

mock.module('node:child_process', {
  namedExports: {
    spawn: (bin, args, opts) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, opts, child });
      setImmediate(() => child.emit('exit', 0));
      return child;
    },
  },
});

const {
  resolveAgyBin,
  runAgyPrint,
  spawnAgyDetached,
  probeAgy,
  DEFAULT_AGY_BIN,
  assertAgyBinSpawnable,
  batchShimRefusalMessage,
  isWindowsBatchFile,
} = await import(
  '../scripts/lib/agent-runtime.mjs'
);

const TMPROOT = os.tmpdir();

function makeExecutable(dir, name) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '');
  return p;
}

// ───────────────────────────── resolveAgyBin ─────────────────────────────

describe('resolveAgyBin — platform-shaped candidates', () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-resolve-'));
  });
  after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('AGY_BIN still wins over everything else', () => {
    assert.equal(resolveAgyBin({ AGY_BIN: process.execPath, PATH: '' }), process.execPath);
  });

  it('posix-shaped: finds a bare "agy" on PATH', () => {
    const dir = fs.mkdtempSync(path.join(root, 'posix-'));
    const bin = makeExecutable(dir, 'agy');
    assert.equal(resolveAgyBin({ PATH: dir }, 'linux'), bin);
  });

  it('win32-shaped: prefers agy.exe over agy.cmd and bare agy on the same PATH dir', () => {
    const dir = fs.mkdtempSync(path.join(root, 'win-exe-'));
    const exe = makeExecutable(dir, 'agy.exe');
    makeExecutable(dir, 'agy.cmd');
    makeExecutable(dir, 'agy');
    assert.equal(resolveAgyBin({ Path: dir }, 'win32'), exe);
  });

  it('win32-shaped: falls back to agy.cmd when no .exe is present', () => {
    const dir = fs.mkdtempSync(path.join(root, 'win-cmd-'));
    const cmd = makeExecutable(dir, 'agy.cmd');
    makeExecutable(dir, 'agy');
    assert.equal(resolveAgyBin({ PATH: dir }, 'win32'), cmd);
  });

  it('win32-shaped: falls back to bare agy when neither .exe nor .cmd exist', () => {
    const dir = fs.mkdtempSync(path.join(root, 'win-bare-'));
    const bare = makeExecutable(dir, 'agy');
    assert.equal(resolveAgyBin({ PATH: dir }, 'win32'), bare);
  });

  it('splits PATH using the real path.delimiter (not a hardcoded ":")', () => {
    const dirA = fs.mkdtempSync(path.join(root, 'multi-a-'));
    const dirB = fs.mkdtempSync(path.join(root, 'multi-b-'));
    const bin = makeExecutable(dirB, 'agy');
    const env = { PATH: [dirA, dirB].join(path.delimiter) };
    assert.equal(resolveAgyBin(env, process.platform), bin);
  });

  it('home fallback checks HOME first, then USERPROFILE', () => {
    const home1 = fs.mkdtempSync(path.join(root, 'home1-'));
    fs.mkdirSync(path.join(home1, '.local', 'bin'), { recursive: true });
    const bin1 = makeExecutable(path.join(home1, '.local', 'bin'), 'agy');
    assert.equal(resolveAgyBin({ PATH: '', HOME: home1 }, 'linux'), bin1);

    const home2 = fs.mkdtempSync(path.join(root, 'home2-'));
    fs.mkdirSync(path.join(home2, '.local', 'bin'), { recursive: true });
    const bin2 = makeExecutable(path.join(home2, '.local', 'bin'), 'agy');
    assert.equal(resolveAgyBin({ PATH: '', USERPROFILE: home2 }, 'linux'), bin2);
  });

  it('falls back to DEFAULT_AGY_BIN when nothing resolves', () => {
    assert.equal(
      resolveAgyBin({ PATH: '/nonexistent/dir', HOME: '/also/nonexistent' }, 'win32'),
      DEFAULT_AGY_BIN,
    );
  });

  it('win32-shaped: two-pass PATH prefers a later agy.exe over an earlier agy.cmd', () => {
    const shimDir = fs.mkdtempSync(path.join(root, 'shim-early-'));
    const exeDir = fs.mkdtempSync(path.join(root, 'exe-late-'));
    makeExecutable(shimDir, 'agy.cmd');
    const exe = makeExecutable(exeDir, 'agy.exe');
    const env = { PATH: [shimDir, exeDir].join(path.delimiter) };
    assert.equal(resolveAgyBin(env, 'win32'), exe);
  });
});

describe('assertAgyBinSpawnable — refuse Windows batch shims', () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-refuse-'));
  });
  after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('throws a message that names AGY_BIN and agy.exe for a .cmd path', () => {
    const cmd = makeExecutable(fs.mkdtempSync(path.join(root, 'cmd-')), 'agy.cmd');
    assert.equal(isWindowsBatchFile(cmd), true);
    assert.throws(
      () => assertAgyBinSpawnable(cmd),
      (err) => {
        assert.match(err.message, /AGY_BIN/);
        assert.match(err.message, /agy\.exe/);
        assert.match(err.message, /\.cmd/i);
        assert.equal(err.message, batchShimRefusalMessage(cmd));
        return true;
      },
    );
  });

  it('refuses AGY_BIN when it points at a .cmd shim', async () => {
    const cmd = makeExecutable(fs.mkdtempSync(path.join(root, 'agybin-')), 'agy.cmd');
    const resolved = resolveAgyBin({ AGY_BIN: cmd, PATH: '' }, 'win32');
    assert.equal(resolved, cmd);

    spawnCalls.length = 0;
    await assert.rejects(runAgyPrint({ prompt: 'p', bin: resolved }), (err) => {
      assert.match(err.message, /AGY_BIN/);
      assert.match(err.message, /agy\.exe/);
      return true;
    });
    assert.equal(spawnCalls.length, 0, 'must not spawn a .cmd shim');

    assert.throws(
      () => spawnAgyDetached({ prompt: 'p', bin: resolved }),
      /AGY_BIN/,
    );
    assert.equal(spawnCalls.length, 0, 'must not spawn a .cmd shim');

    const probe = await probeAgy({ bin: resolved });
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /AGY_BIN/);
    assert.match(probe.reason, /agy\.exe/);
    assert.equal(spawnCalls.length, 0, 'must not spawn a .cmd shim');
  });

  it('refuses a .bat path the same way', () => {
    const bat = makeExecutable(fs.mkdtempSync(path.join(root, 'bat-')), 'agy.bat');
    assert.throws(() => assertAgyBinSpawnable(bat), /AGY_BIN/);
  });

  it('allows a non-batch binary', () => {
    assert.doesNotThrow(() => assertAgyBinSpawnable('agy'));
    assert.doesNotThrow(() => assertAgyBinSpawnable(process.execPath));
  });
});

// ───────────────────────────── model / extraArgs spawn args ─────────────────────────────

describe('runAgyPrint — model + extraArgs spawn-arg placement', () => {
  it('pushes --model <id> after addDirs and before --print', async () => {
    spawnCalls.length = 0;
    await runAgyPrint({ prompt: 'p', bin: 'agy', model: 'gemini-3.6-flash-high', addDirs: ['/extra'] });
    const { args } = spawnCalls[0];
    const addDirIdx = args.indexOf('--add-dir');
    const modelIdx = args.indexOf('--model');
    const printIdx = args.indexOf('--print');
    assert.ok(modelIdx > -1, 'expected --model in spawn args');
    assert.equal(args[modelIdx + 1], 'gemini-3.6-flash-high');
    assert.ok(addDirIdx < modelIdx, '--add-dir should precede --model');
    assert.ok(modelIdx < printIdx, '--model should precede --print');
    assert.deepEqual(
      args.slice(-6),
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print', ''],
      'always ends with the stream-json tail',
    );
    assert.equal(args.includes('p'), false, 'the prompt never lands in argv');
  });

  it('omits --model entirely when not given (non-breaking default)', async () => {
    spawnCalls.length = 0;
    await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(spawnCalls[0].args.includes('--model'), false);
  });

  it('appends extraArgs, in order, after --model and before --print', async () => {
    spawnCalls.length = 0;
    await runAgyPrint({ prompt: 'p', bin: 'agy', model: 'm1', extraArgs: ['--output-format', 'text'] });
    const { args } = spawnCalls[0];
    const modelIdx = args.indexOf('--model');
    const extraIdx = args.indexOf('--output-format');
    const printIdx = args.indexOf('--print');
    assert.ok(modelIdx < extraIdx, '--model should precede extraArgs');
    assert.ok(extraIdx < printIdx, 'extraArgs should precede --print');
    assert.equal(args[extraIdx + 1], 'text');
  });

  it('extraArgs work without a model (independent optionality)', async () => {
    spawnCalls.length = 0;
    await runAgyPrint({ prompt: 'p', bin: 'agy', extraArgs: ['--flag'] });
    const { args } = spawnCalls[0];
    assert.equal(args.includes('--model'), false);
    assert.ok(args.indexOf('--flag') < args.indexOf('--print'));
  });
});

describe('spawnAgyDetached — model + extraArgs symmetry', () => {
  it('pushes --model and extraArgs before --print, mirroring runAgyPrint', () => {
    spawnCalls.length = 0;
    spawnAgyDetached({ prompt: 'p', bin: 'agy', model: 'm2', extraArgs: ['--flag'] });
    const { args } = spawnCalls[0];
    const modelIdx = args.indexOf('--model');
    const flagIdx = args.indexOf('--flag');
    const printIdx = args.indexOf('--print');
    assert.ok(modelIdx > -1 && modelIdx < flagIdx);
    assert.ok(flagIdx < printIdx);
  });

  it('omits --model when not given', () => {
    spawnCalls.length = 0;
    spawnAgyDetached({ prompt: 'p', bin: 'agy' });
    assert.equal(spawnCalls[0].args.includes('--model'), false);
  });
});
