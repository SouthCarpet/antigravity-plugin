/**
 * Opt-in `--request-id <id>` idempotent background dispatch on `task` and
 * `rescue --background` (Senate R12, 2026-09).
 *
 * Every end-to-end case runs real `bin/antigravity.mjs` child processes
 * against a fake `agy` binary (tests/helpers/fake-agy.mjs), the same pattern
 * tests/provenance.test.mjs and tests/job-lifecycle.test.mjs use, so the
 * claim, the job file, the `state.json` index and the detached worker are
 * all the real ones. The concurrency case starts two processes with `spawn`
 * and awaits both together: the claim and the job creation share one locked
 * critical section, so exactly one job file and one `requestIds` entry may
 * exist afterwards.
 *
 * Each case that dispatches a worker ends with a `--wait` on that job, so no
 * detached worker still writes into a data directory the `after` hook
 * removes.
 *
 *   node --test tests/request-id.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestFingerprint } from '../scripts/lib/request-id.mjs';
import { resolveStateDir } from '../scripts/lib/state.mjs';
import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');
const TMPROOT = portableTmpRoot();
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

let stubDir;
let fakeAgy;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-request-id-'));
  fakeAgy = writeFakeAgy(stubDir, 'agy-request-id', {
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
    exitCode: 0,
    versionOk: true,
  });
});

after(() => {
  for (const dir of [...cleanup, stubDir]) removeTestDir(dir);
});

function freshDirs() {
  const work = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-request-id-work-'));
  const data = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-request-id-data-'));
  cleanup.push(work, data);
  const env = {
    ...process.env,
    AGY_BIN: fakeAgy,
    CLAUDE_PLUGIN_DATA: data,
    ANTIGRAVITY_PLUGIN_SESSION_ID: 'reqid-' + randomBytes(3).toString('hex'),
  };
  return { work, data, env };
}

function runVerb(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env, timeout: 60_000 });
}

function runVerbAsync(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function stateDir(work, data) {
  return resolveStateDir(work, { CLAUDE_PLUGIN_DATA: data });
}

function jobFiles(work, data) {
  const dir = path.join(stateDir(work, data), 'jobs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
}

function readState(work, data) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(work, data), 'state.json'), 'utf8'));
}

function readJob(work, data, jobId) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(work, data), 'jobs', `${jobId}.json`), 'utf8'));
}

describe('--request-id fingerprint', () => {
  it('hashes the canonical JSON of the nine request fields, independent of key order', () => {
    const fields = {
      kind: 'task', prompt: 'p', mode: 'print', conversationId: null, addDirs: ['a'],
      extraArgs: [], model: null, effort: 'medium', cwd: '/w',
    };
    const canonical = '{"addDirs":["a"],"conversationId":null,"cwd":"/w","effort":"medium",' +
      '"extraArgs":[],"kind":"task","mode":"print","model":null,"prompt":"p"}';
    const expected = createHash('sha256').update(canonical).digest('hex');
    assert.equal(requestFingerprint(fields), expected);
    const reordered = Object.fromEntries(Object.entries(fields).reverse());
    assert.equal(requestFingerprint(reordered), expected);
    assert.notEqual(requestFingerprint({ ...fields, prompt: 'q' }), expected);
  });
});

describe('--request-id on task (real child processes, fake agy)', () => {
  it('same id and same request twice: one job, the second call reports deduplicated', () => {
    const { work, data, env } = freshDirs();
    const first = runVerb(['task', 'hello', '--request-id', 'req-1', '--json', '--wait'], env, work);
    assert.equal(first.status, 0, first.stderr);
    const queued = JSON.parse(first.stdout);
    assert.equal(queued.status, 'queued');
    assert.equal(Object.hasOwn(queued.details, 'deduplicated'), false);

    const second = runVerb(['task', 'hello', '--request-id', 'req-1', '--json'], env, work);
    assert.equal(second.status, 0, second.stderr);
    const dedup = JSON.parse(second.stdout);
    assert.equal(dedup.command, 'task');
    assert.equal(dedup.status, 'completed');
    assert.equal(dedup.jobId, queued.jobId);
    assert.equal(dedup.details.deduplicated, true);
    assert.equal(typeof dedup.details.message, 'string');
    assert.ok(dedup.details.message.includes(queued.jobId));

    assert.deepEqual(jobFiles(work, data), [`${queued.jobId}.json`]);
    const job = readJob(work, data, queued.jobId);
    assert.equal(job.request.requestId, 'req-1');
    assert.match(job.request.requestFingerprint, FINGERPRINT_RE);
    const entry = readState(work, data).requestIds['req-1'];
    assert.equal(entry.jobId, queued.jobId);
    assert.equal(entry.fingerprint, job.request.requestFingerprint);
    assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  });

  it('a deduplicated call with --wait waits on the existing job and prints its answer', () => {
    const { work, env } = freshDirs();
    const first = runVerb(['task', 'hello', '--request-id', 'req-w', '--json', '--wait'], env, work);
    assert.equal(first.status, 0, first.stderr);
    const { jobId } = JSON.parse(first.stdout);

    const again = runVerb(['task', 'hello', '--request-id', 'req-w', '--wait'], env, work);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.includes(jobId), again.stdout);
    assert.match(again.stdout, /already started/);
    assert.match(again.stdout, /done/);
  });

  it('same id with a different prompt: exit 1, request_id_conflict, still one job', () => {
    const { work, data, env } = freshDirs();
    const first = runVerb(['task', 'hello', '--request-id', 'req-2', '--json', '--wait'], env, work);
    assert.equal(first.status, 0, first.stderr);
    const { jobId } = JSON.parse(first.stdout);

    const conflict = runVerb(['task', 'another prompt', '--request-id', 'req-2', '--json'], env, work);
    assert.equal(conflict.status, 1);
    const envelope = JSON.parse(conflict.stdout);
    assert.equal(envelope.status, 'invalid_input');
    assert.equal(envelope.jobId, null);
    assert.equal(envelope.answer, null);
    assert.equal(envelope.details.error.code, 'request_id_conflict');
    assert.equal(envelope.details.error.phase, 'validate');
    assert.equal(envelope.details.existingJobId, jobId);
    const stderrLines = conflict.stderr.trim().split(/\r?\n/);
    assert.equal(stderrLines.length, 1, conflict.stderr);
    assert.match(stderrLines[0], /^antigravity:task .*--request-id req-2/);

    assert.deepEqual(jobFiles(work, data), [`${jobId}.json`]);
    assert.deepEqual(Object.keys(readState(work, data).requestIds), ['req-2']);
  });

  it('two concurrent processes with the same id produce exactly one job and one entry', async () => {
    const { work, data, env } = freshDirs();
    const args = ['task', 'race', '--request-id', 'race-1', '--json'];
    const results = await Promise.all([runVerbAsync(args, env, work), runVerbAsync(args, env, work)]);
    for (const res of results) assert.equal(res.status, 0, res.stderr);
    const envelopes = results.map((res) => JSON.parse(res.stdout));
    assert.equal(envelopes[0].jobId, envelopes[1].jobId);
    const deduplicated = envelopes.filter((envelope) => envelope.details.deduplicated === true);
    assert.equal(deduplicated.length, 1, JSON.stringify(envelopes));

    assert.deepEqual(jobFiles(work, data), [`${envelopes[0].jobId}.json`]);
    assert.deepEqual(Object.keys(readState(work, data).requestIds), ['race-1']);

    const settle = runVerb(['task', 'race', '--request-id', 'race-1', '--json', '--wait'], env, work);
    assert.equal(settle.status, 0, settle.stderr);
  });

  it('an index rebuild after deleting state.json restores the mapping', () => {
    const { work, data, env } = freshDirs();
    const first = runVerb(['task', 'hello', '--request-id', 'req-3', '--json', '--wait'], env, work);
    assert.equal(first.status, 0, first.stderr);
    const { jobId } = JSON.parse(first.stdout);
    const before = readState(work, data).requestIds['req-3'];

    fs.unlinkSync(path.join(stateDir(work, data), 'state.json'));

    const again = runVerb(['task', 'hello', '--request-id', 'req-3', '--json'], env, work);
    assert.equal(again.status, 0, again.stderr);
    const dedup = JSON.parse(again.stdout);
    assert.equal(dedup.jobId, jobId);
    assert.equal(dedup.details.deduplicated, true);
    const rebuilt = readState(work, data).requestIds['req-3'];
    assert.equal(rebuilt.jobId, jobId);
    assert.equal(rebuilt.fingerprint, before.fingerprint);
    assert.deepEqual(jobFiles(work, data), [`${jobId}.json`]);
  });

  it('a state.json written without requestIds reads as an empty map', () => {
    const { work, data, env } = freshDirs();
    const plain = runVerb(['task', 'plain', '--json', '--wait'], env, work);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(Object.hasOwn(readState(work, data), 'requestIds'), false);

    const claimed = runVerb(['task', 'hello', '--request-id', 'req-4', '--json', '--wait'], env, work);
    assert.equal(claimed.status, 0, claimed.stderr);
    const { jobId } = JSON.parse(claimed.stdout);
    assert.deepEqual(Object.keys(readState(work, data).requestIds), ['req-4']);
    assert.equal(readState(work, data).requestIds['req-4'].jobId, jobId);
    assert.equal(jobFiles(work, data).length, 2);
  });

  it('task without the flag stores no request id fields and no requestIds map', () => {
    const { work, data, env } = freshDirs();
    const res = runVerb(['task', 'hello', '--json', '--wait'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);
    const job = readJob(work, data, jobId);
    assert.equal(Object.hasOwn(job, 'requestId'), false);
    assert.equal(Object.hasOwn(job.request, 'requestId'), false);
    assert.equal(Object.hasOwn(job.request, 'requestFingerprint'), false);
    assert.equal(Object.hasOwn(readState(work, data), 'requestIds'), false);
  });
});

describe('--request-id on rescue --background', () => {
  it('deduplicates a second identical background rescue', () => {
    const { work, data, env } = freshDirs();
    const first = runVerb(['rescue', 'why', '--background', '--request-id', 'rescue.1', '--json', '--wait'], env, work);
    assert.equal(first.status, 0, first.stderr);
    const { jobId } = JSON.parse(first.stdout);

    const second = runVerb(['rescue', 'why', '--background', '--request-id', 'rescue.1', '--json'], env, work);
    assert.equal(second.status, 0, second.stderr);
    const dedup = JSON.parse(second.stdout);
    assert.equal(dedup.command, 'rescue');
    assert.equal(dedup.jobId, jobId);
    assert.equal(dedup.details.deduplicated, true);
    assert.deepEqual(jobFiles(work, data), [`${jobId}.json`]);
  });
});

describe('--request-id argument validation', () => {
  const refusals = [
    ['task --foreground', ['task', 'x', '--foreground', '--request-id', 'a'], 'antigravity:task — --request-id applies to background jobs only'],
    ['rescue without --background', ['rescue', 'x', '--request-id', 'a'], 'antigravity:rescue — --request-id applies to background jobs only'],
  ];
  for (const [label, args, line] of refusals) {
    it(`${label} is refused before any job exists`, () => {
      const { work, data, env } = freshDirs();
      const res = runVerb(args, env, work);
      assert.equal(res.status, 1);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, `${line}\n`);
      assert.deepEqual(jobFiles(work, data), []);
    });
  }

  const invalidIds = [
    ['too long', 'a'.repeat(129)],
    ['a bad character', 'bad/id'],
    ['a space', 'bad id'],
    ['empty', ''],
  ];
  for (const [label, id] of invalidIds) {
    it(`an id with ${label} is refused naming the flag`, () => {
      const { work, data, env } = freshDirs();
      const res = runVerb(['task', 'x', '--request-id', id], env, work);
      assert.equal(res.status, 1);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /^antigravity:task — invalid value for --request-id/);
      assert.equal(res.stderr.trim().split(/\r?\n/).length, 1);
      assert.deepEqual(jobFiles(work, data), []);
    });
  }

  it('an id of exactly 128 allowed characters is accepted', () => {
    const { work, data, env } = freshDirs();
    const id = 'A.b_c-9'.repeat(19).slice(0, 128);
    assert.equal(id.length, 128);
    const res = runVerb(['task', 'x', '--request-id', id, '--json', '--wait'], env, work);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(Object.keys(readState(work, data).requestIds), [id]);
  });
});
