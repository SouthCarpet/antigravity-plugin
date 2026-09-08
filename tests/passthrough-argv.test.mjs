/**
 * Flags that must reach agy's argv verbatim and in order (plan 068 T3/T4).
 *
 * Runs `bin/antigravity.mjs <verb>` in a child process with `AGY_BIN`
 * pointed at a fake agy that echoes its argv to stderr and exits 1. A
 * failing run is the one path on which every verb prints the child's
 * stderr, so the argv becomes observable through the real dispatcher, the
 * real verb and the real spawn (no mocks, no in-process stdout capture).
 * The background `task` path is read back through `result --json`, whose
 * `details.result.stderr` is the worker's stored copy of that stderr.
 *
 *   node --test tests/passthrough-argv.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { writeFakeAgy } from './helpers/fake-agy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');

let stubDir;
let echoAgy;
let successAgy;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-argv-'));
  // versionOk: the verbs probe `agy --version` first; this fake must pass
  // that probe and fail only the run.
  echoAgy = writeFakeAgy(stubDir, 'agy-echo', { echoArgsStderr: true, exitCode: 1, versionOk: true });
  successAgy = writeFakeAgy(stubDir, 'agy-success', {
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
    echoArgsStderr: true, exitCode: 0, versionOk: true,
  });
});

after(() => {
  for (const dir of [stubDir, ...cleanup]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeEnv(data) {
  return {
    ...process.env,
    AGY_BIN: echoAgy,
    CLAUDE_PLUGIN_DATA: data,
    ANTIGRAVITY_PLUGIN_SESSION_ID: 'argv-' + randomBytes(3).toString('hex'),
  };
}

function runVerb(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

function freshDirs() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-argv-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-argv-data-'));
  cleanup.push(work, data);
  return { work, data };
}

/**
 * The `arg=` lines from a stderr blob, in order. A redirected .NET console
 * stream can start with a BOM, which would hide the first line from a plain
 * `startsWith('arg=')`, so each line drops a leading U+FEFF first.
 */
function argvOf(stderr) {
  return String(stderr)
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, ''))
    .filter((l) => l.startsWith('arg='))
    .map((l) => l.slice(4));
}

/** Assert `needle` appears in `hay` as a contiguous run, printing both otherwise. */
function assertRun(hay, needle) {
  const found = hay.some((_, i) => needle.every((v, j) => hay[i + j] === v));
  assert.ok(found, `expected run [${needle.join(' ')}] in argv [${hay.join(' ')}]`);
}

describe('--add-dir reaches agy argv verbatim and in order', () => {
  it('rescue: two --add-dir values, in the order given, before the stream-json tail', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'read it', '--add-dir', 'C:\\one dir', '--add-dir', '/two'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    const argv = argvOf(res.stderr);
    assertRun(argv, ['--add-dir', 'C:\\one dir', '--add-dir', '/two']);
    assert.ok(argv.indexOf('--add-dir') < argv.indexOf('--input-format'));
  });

  it('task --foreground: three --add-dir values, in the order given', () => {
    const { work, data } = freshDirs();
    const res = runVerb(
      ['task', 'read it', '--foreground', '--add-dir', 'a', '--add-dir', 'b', '--add-dir', 'c'],
      makeEnv(data), work,
    );
    assert.equal(res.status, 1, res.stderr);
    assertRun(argvOf(res.stderr), ['--add-dir', 'a', '--add-dir', 'b', '--add-dir', 'c']);
  });

  it('task (background worker): --add-dir survives the job file and reaches argv in order', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data);
    const queued = runVerb(['task', 'read it', '--add-dir', 'x', '--add-dir', 'y', '--wait', '--json'], env, work);
    assert.equal(queued.status, 1, queued.stderr); // the fake exits 1, so the job fails
    const { jobId } = JSON.parse(queued.stdout);
    const stored = runVerb(['result', jobId, '--json'], env, work);
    assert.equal(stored.status, 1, stored.stderr); // failed job → 1, payload still emitted
    const payload = JSON.parse(stored.stdout);
    assertRun(argvOf(payload.details.result.stderr), ['--add-dir', 'x', '--add-dir', 'y']);
  });
});

describe('--print-timeout and --disable-slash-commands reach agy argv on every print-mode path (D1 / D2)', () => {
  const DEFAULT_BUDGET_ARGV_TAIL = [
    '--print-timeout', '1860s',
    '--disable-slash-commands',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '',
  ];

  it('rescue (foreground): both flags appear once, before the stream-json tail', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'read it'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(argvOf(res.stderr), DEFAULT_BUDGET_ARGV_TAIL);
  });

  it('task --foreground: both flags appear once, before the stream-json tail', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['task', 'read it', '--foreground'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(argvOf(res.stderr), DEFAULT_BUDGET_ARGV_TAIL);
  });

  it('task (background worker): both flags reach argv the same way', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data);
    const queued = runVerb(['task', 'read it', '--wait', '--json'], env, work);
    assert.equal(queued.status, 1, queued.stderr);
    const { jobId } = JSON.parse(queued.stdout);
    const stored = runVerb(['result', jobId, '--json'], env, work);
    const argv = argvOf(JSON.parse(stored.stdout).details.result.stderr);
    assert.deepEqual(argv, DEFAULT_BUDGET_ARGV_TAIL);
  });

  it('rescue --conversation <id>: both flags appear after --conversation and before the tail', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'continue it', '--conversation', 'thr_1'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(argvOf(res.stderr), ['--conversation', 'thr_1', ...DEFAULT_BUDGET_ARGV_TAIL]);
  });
});

describe('--mode <plan|accept-edits> reaches agy argv; anything else is an ArgsError', () => {
  it('rescue --mode plan lands as `--mode plan` after --add-dir and before the tail', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'plan it', '--add-dir', 'd', '--mode', 'plan'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    const argv = argvOf(res.stderr);
    assertRun(argv, ['--add-dir', 'd', '--mode', 'plan']);
    assert.ok(argv.indexOf('--mode') < argv.indexOf('--input-format'));
  });

  it('task --foreground --mode accept-edits lands as `--mode accept-edits`', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['task', 'edit it', '--foreground', '--mode', 'accept-edits'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assertRun(argvOf(res.stderr), ['--mode', 'accept-edits']);
  });

  it('task (background worker): --mode survives the job file', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data);
    const queued = runVerb(['task', 'plan it', '--mode', 'plan', '--wait', '--json'], env, work);
    assert.equal(queued.status, 1, queued.stderr);
    const { jobId } = JSON.parse(queued.stdout);
    const stored = runVerb(['result', jobId, '--json'], env, work);
    assertRun(argvOf(JSON.parse(stored.stdout).details.result.stderr), ['--mode', 'plan']);
  });

  it('an unknown --mode value exits 1, names the flag and the choices, and never spawns agy', () => {
    const { work, data } = freshDirs();
    for (const verb of [['rescue', 'x'], ['task', 'x', '--foreground']]) {
      const res = runVerb([...verb, '--mode', 'yolo'], makeEnv(data), work);
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, /antigravity:(rescue|task) — invalid value for --mode: "yolo" \(expected plan\|accept-edits\)/);
      assert.deepEqual(argvOf(res.stderr), [], 'agy must not be spawned');
    }
  });
});

describe('--effort <low|medium|high> reaches agy argv; anything else is an ArgsError', () => {
  const DEFAULT_BUDGET_ARGV_TAIL = [
    '--print-timeout', '1860s',
    '--disable-slash-commands',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '',
  ];

  it('rescue --effort low lands as `--effort low`, with no --model, before the tail', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'x', '--effort', 'low'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(argvOf(res.stderr), ['--effort', 'low', ...DEFAULT_BUDGET_ARGV_TAIL]);
  });

  it('task --foreground --effort high lands as `--effort high` right after --model', () => {
    const { work, data } = freshDirs();
    const res = runVerb(
      ['task', 'x', '--foreground', '--model', 'gemini-x', '--effort', 'high'],
      makeEnv(data), work,
    );
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(
      argvOf(res.stderr),
      ['--model', 'gemini-x', '--effort', 'high', ...DEFAULT_BUDGET_ARGV_TAIL],
    );
  });

  it('task (background worker): --effort survives the job file and reaches argv', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data);
    const queued = runVerb(['task', 'x', '--effort', 'medium', '--wait', '--json'], env, work);
    assert.equal(queued.status, 1, queued.stderr);
    const { jobId } = JSON.parse(queued.stdout);
    const stored = runVerb(['result', jobId, '--json'], env, work);
    assert.deepEqual(
      argvOf(JSON.parse(stored.stdout).details.result.stderr),
      ['--effort', 'medium', ...DEFAULT_BUDGET_ARGV_TAIL],
    );
  });

  it('rescue --effort high --mode plan: --effort lands before --mode (extraArgs), not after', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'x', '--effort', 'high', '--mode', 'plan'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(
      argvOf(res.stderr),
      ['--effort', 'high', '--mode', 'plan', ...DEFAULT_BUDGET_ARGV_TAIL],
    );
  });

  it('an unknown --effort value exits 1, names the flag and the choices, and never spawns agy', () => {
    const { work, data } = freshDirs();
    for (const verb of [['rescue', 'x'], ['task', 'x', '--foreground']]) {
      const res = runVerb([...verb, '--effort', 'max'], makeEnv(data), work);
      assert.equal(res.status, 1, res.stderr);
      assert.match(
        res.stderr,
        /antigravity:(rescue|task) — invalid value for --effort: "max" \(expected low\|medium\|high\)/,
      );
      assert.deepEqual(argvOf(res.stderr), [], 'agy must not be spawned');
    }
  });

  it('a prompt that merely contains the words "--effort high" stays a prompt', () => {
    const { work, data } = freshDirs();
    const env = { ...makeEnv(data), AGY_BIN: successAgy };
    const res = runVerb(['task', 'Explain --effort high', '--foreground', '--json'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);
    const records = fs.readdirSync(data, { recursive: true }).filter(file => file.endsWith(jobId + '.json'));
    assert.equal(records.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(data, records[0]), 'utf8'));
    assert.equal(stored.request.prompt, 'Explain --effort high');
    assert.ok(!argvOf(stored.result.stderr).includes('--effort'));
  });
});

describe('vision --add-dir is rejected before any spawn', () => {
  it('vision --add-dir exits 1, names the flag, and never spawns agy', () => {
    const { work, data } = freshDirs();
    const img = path.join(work, 'shot.png');
    fs.writeFileSync(img, 'not-a-real-png');
    const res = runVerb(['vision', img, '--add-dir', 'C:\\scope'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /antigravity:vision — unknown flag --add-dir; put prompt text after --/);
    assert.deepEqual(argvOf(res.stderr), [], 'agy must not be spawned');
  });
});

describe('standalone argv boundaries', () => {
  it('persists a quoted prompt containing --mode without granting that mode', () => {
    const { work, data } = freshDirs();
    const env = { ...makeEnv(data), AGY_BIN: successAgy };
    const res = runVerb(['task', 'Explain --mode accept-edits', '--foreground', '--json'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);
    const records = fs.readdirSync(data, { recursive: true }).filter(file => file.endsWith(jobId + '.json'));
    assert.equal(records.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(data, records[0]), 'utf8'));
    assert.equal(stored.request.prompt, 'Explain --mode accept-edits');
    assert.ok(!argvOf(stored.result.stderr).includes('--mode'));
  });

  it('vision accepts a shell-quoted image path with spaces', () => {
    const { work, data } = freshDirs();
    const img = path.join(work, 'screen shot.png');
    fs.writeFileSync(img, 'not-a-real-png');
    const res = runVerb(['vision', img, '--json'], { ...makeEnv(data), AGY_BIN: successAgy }, work);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).command, 'vision');
    assert.deepEqual(JSON.parse(res.stdout).imagePaths, [img]);
  });

  it('keeps flag-like prompt words after -- through the standalone CLI', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['task', '--foreground', '--json', '--', 'explain', '--verbose'], { ...makeEnv(data), AGY_BIN: successAgy }, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);
    const records = fs.readdirSync(data, { recursive: true }).filter(file => file.endsWith(jobId + '.json'));
    assert.equal(records.length, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(data, records[0]), 'utf8'));
    assert.equal(stored.request.prompt, 'explain --verbose');
  });
});
