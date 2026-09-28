/**
 * `task --prompt-file <path>` and `--prompt-file -` (stdin) (Senate R13,
 * 2026-09).
 *
 * Every case runs the real `bin/antigravity.mjs` as a child process against
 * a fake `agy` binary (tests/helpers/fake-agy.mjs), the same pattern
 * tests/request-id.test.mjs and tests/passthrough-argv.test.mjs use, so the
 * parser, the validation, the job file and the stored `request.prompt` are
 * all the real ones. Refusal cases use a fake agy with `touchFile` set to
 * prove agy was never spawned (the file must not exist afterwards).
 *
 *   node --test tests/prompt-file.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { MAX_PROMPT_FILE_BYTES } from '../scripts/lib/prompt-source.mjs';
import { resolveStateDir } from '../scripts/lib/state.mjs';
import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');
const TMPROOT = portableTmpRoot();

let stubDir;
let fakeAgy;
let agyTouchFile;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-prompt-file-'));
  agyTouchFile = path.join(stubDir, 'agy-was-spawned.marker');
  fakeAgy = writeFakeAgy(stubDir, 'agy-prompt-file', {
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
    exitCode: 0,
    versionOk: true,
    touchFile: agyTouchFile,
  });
});

after(() => {
  for (const dir of [...cleanup, stubDir]) removeTestDir(dir);
});

function freshDirs() {
  const work = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-prompt-file-work-'));
  const data = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-prompt-file-data-'));
  cleanup.push(work, data);
  if (fs.existsSync(agyTouchFile)) fs.rmSync(agyTouchFile);
  const env = {
    ...process.env,
    AGY_BIN: fakeAgy,
    CLAUDE_PLUGIN_DATA: data,
    ANTIGRAVITY_PLUGIN_SESSION_ID: 'pf-' + randomBytes(3).toString('hex'),
  };
  return { work, data, env };
}

function runVerb(args, env, cwd, extra = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env, timeout: 60_000, ...extra });
}

function stateDir(work, data) {
  return resolveStateDir(work, { CLAUDE_PLUGIN_DATA: data });
}

function readJob(work, data, jobId) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(work, data), 'jobs', `${jobId}.json`), 'utf8'));
}

function jobFiles(work, data) {
  const dir = path.join(stateDir(work, data), 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
}

describe('task --prompt-file: happy paths', () => {
  it('reads a file whose path contains spaces, storing the content minus the trailing newline', () => {
    const { work, data, env } = freshDirs();
    const dirWithSpace = fs.mkdtempSync(path.join(TMPROOT, 'antigravity prompt file dir '));
    cleanup.push(dirWithSpace);
    const filePath = path.join(dirWithSpace, 'my prompt.txt');
    fs.writeFileSync(filePath, 'do the thing\n', 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--json', '--wait'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.status, 'queued');

    const job = readJob(work, data, envelope.jobId);
    assert.equal(job.request.prompt, 'do the thing');
    assert.equal(job.title, 'do the thing');
    // The path itself never lands in provenance or stderr.
    assert.equal(res.stderr.includes(filePath), false);
    assert.equal(JSON.stringify(job.provenance).includes(filePath), false);
  });

  it('stores multi-line content with a leading "/" line verbatim (minus the trailing newline)', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'multiline-prompt.txt');
    const content = '/list files\nsecond line\nthird line with trailing spaces   \n';
    fs.writeFileSync(filePath, content, 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--json', '--wait'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const envelope = JSON.parse(res.stdout);
    const job = readJob(work, data, envelope.jobId);
    assert.equal(job.request.prompt, content.slice(0, -1));
    assert.equal(job.title, '/list files');
  });

  it('truncates the title to 80 chars from the first non-empty line, not the whole content', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'long-title.txt');
    const longLine = 'x'.repeat(120);
    fs.writeFileSync(filePath, `\n  \n${longLine}\nsecond line\n`, 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--json', '--wait'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const envelope = JSON.parse(res.stdout);
    const job = readJob(work, data, envelope.jobId);
    assert.equal(job.title, `${'x'.repeat(77)}...`);
    assert.equal(job.title.length, 80);
  });

  it('--continue combined with --prompt-file uses the file content as the new turn', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'continue-prompt.txt');
    fs.writeFileSync(filePath, 'keep going\n', 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--continue', '--json', '--wait'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const envelope = JSON.parse(res.stdout);
    const job = readJob(work, data, envelope.jobId);
    assert.equal(job.request.prompt, 'keep going');
    assert.equal(job.request.mode, 'continue');
  });
});

describe('task --prompt-file: refusals', () => {
  it('a file over the byte cap is refused, exit 1, no agy spawn', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'too-big.txt');
    fs.writeFileSync(filePath, 'a'.repeat(MAX_PROMPT_FILE_BYTES + 1), 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--json'], env, work);
    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.status, 'invalid_input');
    assert.equal(envelope.answer, null);
    assert.equal(envelope.jobId, null);
    assert.equal(envelope.details.error.code, 'prompt_file_too_large');
    assert.equal(envelope.details.error.phase, 'validate');
    assert.match(envelope.details.error.message, new RegExp(String(MAX_PROMPT_FILE_BYTES)));
    assert.match(envelope.details.error.message, /\d+ bytes/);

    assert.equal(fs.existsSync(agyTouchFile), false, 'agy must never be spawned on an over-limit file');
    assert.deepEqual(jobFiles(work, data), []);
    assert.equal(res.stderr.includes(filePath), false);
  });

  it('a missing file is refused as prompt_file_unreadable', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'does-not-exist.txt');

    const res = runVerb(['task', '--prompt-file', filePath, '--json'], env, work);
    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.status, 'invalid_input');
    assert.equal(envelope.details.error.code, 'prompt_file_unreadable');
    assert.equal(envelope.details.error.phase, 'validate');
    assert.equal(fs.existsSync(agyTouchFile), false);
    assert.deepEqual(jobFiles(work, data), []);
    assert.equal(res.stderr.includes(filePath), false);
  });

  it('an empty file is refused as prompt_file_empty', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'empty.txt');
    fs.writeFileSync(filePath, '', 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--json'], env, work);
    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.details.error.code, 'prompt_file_empty');
    assert.equal(fs.existsSync(agyTouchFile), false);
    assert.deepEqual(jobFiles(work, data), []);
  });

  it('a whitespace-only file is refused as prompt_file_empty', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'whitespace.txt');
    fs.writeFileSync(filePath, '   \n\t\n  \n', 'utf8');

    const res = runVerb(['task', '--prompt-file', filePath, '--json'], env, work);
    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.details.error.code, 'prompt_file_empty');
    assert.deepEqual(jobFiles(work, data), []);
  });

  it('a positional prompt together with --prompt-file is refused before any read', () => {
    const { work, data, env } = freshDirs();
    const filePath = path.join(work, 'irrelevant.txt');
    fs.writeFileSync(filePath, 'unused', 'utf8');

    const res = runVerb(['task', 'a positional prompt', '--prompt-file', filePath], env, work);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, 'antigravity:task — cannot combine --prompt-file with a positional prompt\n');
    assert.equal(fs.existsSync(agyTouchFile), false);
    assert.deepEqual(jobFiles(work, data), []);
  });

  it('--prompt-file - under a host wrapper env is refused as standalone-only, even through bin', () => {
    const { work, data, env } = freshDirs();
    const res = runVerb(['task', '--prompt-file', '-', '--json'], { ...env, ANTIGRAVITY_HOST_WRAPPER: '1' }, work, {
      input: 'from stdin\n',
    });
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, 'antigravity:task — --prompt-file - (stdin) is available in the standalone CLI only\n');
    assert.equal(fs.existsSync(agyTouchFile), false);
    assert.deepEqual(jobFiles(work, data), []);
  });

  it('--json refusals emit exactly one JSON envelope on stdout and no envelope leaks to stderr', () => {
    const { work, env } = freshDirs();
    const filePath = path.join(work, 'missing-for-json.txt');
    const res = runVerb(['task', '--prompt-file', filePath, '--json'], env, work);
    assert.equal(res.status, 1);
    // stdout parses as exactly one JSON value.
    const parsed = JSON.parse(res.stdout);
    assert.equal(typeof parsed, 'object');
    assert.equal(parsed.details.error.code, 'prompt_file_unreadable');
    // The plugin's own stderr line is separate from the JSON envelope.
    assert.match(res.stderr, /^antigravity:task — /);
  });
});

describe('task --prompt-file -: stdin (standalone CLI only)', () => {
  it('is accepted through bin/antigravity.mjs with piped stdin', () => {
    const { work, data, env } = freshDirs();
    const res = runVerb(['task', '--prompt-file', '-', '--json', '--wait'], env, work, {
      input: 'hello from stdin\n',
    });
    assert.equal(res.status, 0, res.stderr);
    const envelope = JSON.parse(res.stdout);
    const job = readJob(work, data, envelope.jobId);
    assert.equal(job.request.prompt, 'hello from stdin');
    assert.equal(job.title, 'hello from stdin');
  });

  it('an over-limit stdin stream is refused as prompt_file_too_large, no agy spawn', () => {
    const { work, data, env } = freshDirs();
    const res = runVerb(['task', '--prompt-file', '-', '--json'], env, work, {
      input: 'a'.repeat(MAX_PROMPT_FILE_BYTES + 10),
    });
    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.details.error.code, 'prompt_file_too_large');
    assert.match(envelope.details.error.message, /\d+ bytes/);
    assert.equal(fs.existsSync(agyTouchFile), false);
    assert.deepEqual(jobFiles(work, data), []);
  });

  it('an empty stdin stream is refused as prompt_file_empty', () => {
    const { work, data, env } = freshDirs();
    const res = runVerb(['task', '--prompt-file', '-', '--json'], env, work, { input: '' });
    assert.equal(res.status, 1);
    const envelope = JSON.parse(res.stdout);
    assert.equal(envelope.details.error.code, 'prompt_file_empty');
    assert.deepEqual(jobFiles(work, data), []);
  });
});
