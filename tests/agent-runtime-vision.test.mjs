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
  return child;
}

mock.module('node:child_process', {
  namedExports: {
    spawn: (bin, args, opts) => {
      spawnCalls.push({ bin, args, opts });
      const child = makeFakeChild();
      setImmediate(() => child.emit('exit', 0));
      return child;
    },
  },
});

const { resolveAgyBin, runAgyPrint, spawnAgyDetached, DEFAULT_AGY_BIN } = await import(
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
