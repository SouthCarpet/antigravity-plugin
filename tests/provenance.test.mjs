/**
 * Tests for safe job provenance and the measured-usage trailer (Task 2,
 * 2026-09): a job record's `provenance` object, `buildStoredResult`'s
 * `reportedModel`, legacy-record handling, and the trailer that now prints
 * for `review`/`rescue`/`task` foreground and background-wait paths too, not
 * only `vision`/`result`.
 *
 * Follows tests/passthrough-argv.test.mjs and tests/job-lifecycle.test.mjs:
 * real `bin/antigravity.mjs` child processes against a fake `agy` binary
 * (tests/helpers/fake-agy.mjs) for the end-to-end shape, plus a couple of
 * direct `createTrackedJob`/`render.mjs` calls for cases a real agy run
 * cannot easily produce (a verb with no model/effort concept, a legacy
 * record, a synthetic status snapshot).
 *
 *   node --test tests/provenance.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const TMPROOT = portableTmpRoot();

const PROVENANCE_KEYS = ['pluginVersion', 'agyVersion', 'model', 'effort', 'mode', 'addDirCount', 'requestedAt'].sort();

let stubDir;
let successNoUsage;
let successWithUsage;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-provenance-'));
  successNoUsage = writeFakeAgy(stubDir, 'agy-no-usage', {
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
    exitCode: 0, versionOk: true,
  });
  successWithUsage = writeFakeAgy(stubDir, 'agy-with-usage', {
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done",' +
      '"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n',
    exitCode: 0, versionOk: true,
  });
});

after(() => {
  for (const dir of [stubDir, ...cleanup]) {
    removeTestDir(dir);
  }
});

function makeEnv(data, bin) {
  return {
    ...process.env,
    AGY_BIN: bin,
    CLAUDE_PLUGIN_DATA: data,
    ANTIGRAVITY_PLUGIN_SESSION_ID: 'prov-' + randomBytes(3).toString('hex'),
  };
}

function runVerb(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

function freshDirs() {
  const work = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-provenance-work-'));
  const data = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-provenance-data-'));
  cleanup.push(work, data);
  return { work, data };
}

describe('provenance — foreground job record (CLI, real fake-agy spawn)', () => {
  it('task --foreground with --model/--effort/--add-dir stores the exact field set, correct values, and leaks no prompt/cwd/path', () => {
    const { work, data } = freshDirs();
    const secretAddDir = path.join(work, 'super-secret-add-dir');
    fs.mkdirSync(secretAddDir);
    const promptMarker = 'PROMPT-MARKER-DO-NOT-LEAK';
    const env = makeEnv(data, successNoUsage);

    const res = runVerb(
      ['task', promptMarker, '--foreground', '--json', '--model', 'gemini-x', '--effort', 'high', '--add-dir', secretAddDir],
      env, work,
    );
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);

    const statusRes = runVerb(['status', jobId, '--json'], env, work);
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const provenance = JSON.parse(statusRes.stdout).details.job.provenance;

    assert.deepEqual(Object.keys(provenance).sort(), PROVENANCE_KEYS);
    assert.equal(provenance.pluginVersion, PACKAGE_VERSION);
    assert.equal(provenance.agyVersion, '0.0.0-fake');
    assert.equal(provenance.model, 'gemini-x');
    assert.equal(provenance.effort, 'high');
    assert.equal(provenance.mode, 'print');
    assert.equal(provenance.addDirCount, 1);
    assert.ok(Number.isFinite(Date.parse(provenance.requestedAt)), 'requestedAt should be a parseable timestamp');

    const serialized = JSON.stringify(provenance);
    assert.ok(!serialized.includes(promptMarker), 'provenance must not carry the prompt');
    assert.ok(!serialized.includes(secretAddDir), 'provenance must not carry the add-dir path');
    assert.ok(!serialized.includes(work), 'provenance must not carry the workspace path');
  });

  it('task (background, default) stores the same provenance shape', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data, successNoUsage);
    const queued = runVerb(['task', 'background prompt', '--wait', '--json', '--model', 'gemini-y'], env, work);
    assert.equal(queued.status, 0, queued.stderr);
    const { jobId } = JSON.parse(queued.stdout);

    const resultRes = runVerb(['result', jobId, '--json'], env, work);
    assert.equal(resultRes.status, 0, resultRes.stderr);
    const provenance = JSON.parse(resultRes.stdout).details.provenance;

    assert.deepEqual(Object.keys(provenance).sort(), PROVENANCE_KEYS);
    assert.equal(provenance.pluginVersion, PACKAGE_VERSION);
    assert.equal(provenance.agyVersion, '0.0.0-fake');
    assert.equal(provenance.model, 'gemini-y');
    // No --effort was given, no --model-less default applies here because a
    // model WAS given: resolveRequestEffort stores the agy-default sentinel.
    assert.equal(provenance.effort, 'agy-default');
    assert.equal(provenance.mode, 'print');
    assert.equal(provenance.addDirCount, 0);
  });
});

describe('provenance — a verb with no model/effort concept (review)', () => {
  it('createTrackedJob with a review-shaped request stores null model and effort', async () => {
    const { work, data } = freshDirs();
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data;
    try {
      const { createTrackedJob } = await import('../scripts/lib/job-helpers.mjs');
      const job = await createTrackedJob({
        workspaceRoot: work,
        kind: 'review',
        title: 'review: working-tree',
        request: { scope: 'working-tree', base: null, mode: 'print' },
        agyVersion: '9.9.9-review',
      });
      assert.equal(job.provenance.model, null);
      assert.equal(job.provenance.effort, null);
      assert.equal(job.provenance.mode, 'print');
      assert.equal(job.provenance.addDirCount, 0);
      assert.equal(job.provenance.agyVersion, '9.9.9-review');
    } finally {
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
    }
  });
});

describe('provenance — legacy records render and report null, never throw', () => {
  it('status <id> and result <id> treat a record with no provenance/reportedModel as null', async () => {
    const { work, data } = freshDirs();
    const savedData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data;
    try {
      const { writeJobFile, upsertJob } = await import('../scripts/lib/state.mjs');
      const legacyId = 'aaaabbbbcccc';
      const legacyJob = {
        id: legacyId,
        kind: 'task',
        title: 'legacy job',
        status: 'completed',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:01.000Z',
        completedAt: '2020-01-01T00:00:01.000Z',
        summary: 'legacy answer',
        result: {
          rawOutput: 'legacy answer\n', stderr: '', status: 'completed', exitCode: 0, warnings: [],
        },
      };
      await writeJobFile(work, legacyId, legacyJob);
      await upsertJob(work, legacyJob);

      const env = makeEnv(data, successNoUsage);
      const statusJson = runVerb(['status', legacyId, '--json'], env, work);
      assert.equal(statusJson.status, 0, statusJson.stderr);
      const statusPayload = JSON.parse(statusJson.stdout);
      assert.equal(statusPayload.details.job.provenance, null);
      assert.equal(statusPayload.details.job.result.reportedModel, null);

      const statusMd = runVerb(['status', legacyId], env, work);
      assert.equal(statusMd.status, 0, statusMd.stderr);
      assert.doesNotMatch(statusMd.stdout, /## Provenance/);

      const resultJson = runVerb(['result', legacyId, '--json'], env, work);
      assert.equal(resultJson.status, 0, resultJson.stderr);
      const resultPayload = JSON.parse(resultJson.stdout);
      assert.equal(resultPayload.details.provenance, null);
      assert.equal(resultPayload.details.reportedModel, null);

      const resultMd = runVerb(['result', legacyId], env, work);
      assert.equal(resultMd.status, 0, resultMd.stderr);
      assert.doesNotMatch(resultMd.stdout, /## Provenance/);
    } finally {
      if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedData;
    }
  });
});

describe('provenance — display (status/result markdown)', () => {
  it('status <id> markdown shows only the non-null provenance fields', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data, successNoUsage);
    const res = runVerb(['task', 'show me', '--foreground', '--json', '--model', 'gemini-z'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);

    const statusMd = runVerb(['status', jobId], env, work);
    assert.equal(statusMd.status, 0, statusMd.stderr);
    assert.match(statusMd.stdout, /## Provenance/);
    assert.match(statusMd.stdout, /\*\*Model:\*\* gemini-z/);
    assert.match(statusMd.stdout, /\*\*agy version:\*\* 0\.0\.0-fake/);
  });

  it('result <id> markdown appends "## Provenance" after the answer, never inside it', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data, successNoUsage);
    const res = runVerb(['task', 'show me too', '--foreground', '--json', '--model', 'gemini-q'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);

    const resultMd = runVerb(['result', jobId], env, work);
    assert.equal(resultMd.status, 0, resultMd.stderr);
    const answerIndex = resultMd.stdout.indexOf('done');
    const provenanceIndex = resultMd.stdout.indexOf('## Provenance');
    assert.ok(answerIndex >= 0 && provenanceIndex > answerIndex, 'Provenance section must come after the answer');
  });
});

describe('usage trailer — every reader, not just vision/result (plan 103 T2)', () => {
  it('task --foreground prints the trailer when the result event carries usage, absent when it does not', () => {
    const { work, data } = freshDirs();

    const withUsage = runVerb(['task', 'x', '--foreground', '--json'], makeEnv(data, successWithUsage), work);
    assert.equal(withUsage.status, 0, withUsage.stderr);
    assert.match(withUsage.stderr, /usage: total=12 in=10 out=2/);

    const noUsage = runVerb(['task', 'x', '--foreground', '--json'], makeEnv(data, successNoUsage), work);
    assert.equal(noUsage.status, 0, noUsage.stderr);
    assert.doesNotMatch(noUsage.stderr, /usage: total=/);
  });

  it('rescue (foreground) also prints the trailer now', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'x'], makeEnv(data, successWithUsage), work);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /usage: total=12 in=10 out=2/);
  });

  it('task --wait (background) prints the trailer from the stored result once the job completes', () => {
    const { work, data } = freshDirs();
    const env = makeEnv(data, successWithUsage);
    const res = runVerb(['task', 'x', '--wait', '--json'], env, work);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /usage: total=12 in=10 out=2/);
  });
});

describe('recent jobs table — Model/Effort columns are opt-in (plan 103 T2)', () => {
  it('adds no Model/Effort columns when every listed job has null provenance values', async () => {
    const { renderStatusSnapshot } = await import('../scripts/lib/render.mjs');
    const provenance = {
      pluginVersion: '2.0.2', agyVersion: null, model: null, effort: null,
      mode: 'print', addDirCount: 0, requestedAt: '2026-09-27T00:00:00.000Z',
    };
    const snapshot = {
      workspaceRoot: 'x', config: {}, needsReview: false, running: [], latestFinished: null,
      recent: [{ id: 'aaaaaaaaaaaa', kind: 'task', status: 'completed', createdAt: 't', updatedAt: 't', completedAt: 't', provenance }],
    };
    const md = renderStatusSnapshot(snapshot);
    assert.doesNotMatch(md, /\| Model \| Effort \|/);
  });

  it('adds Model/Effort columns when at least one listed job names either', async () => {
    const { renderStatusSnapshot } = await import('../scripts/lib/render.mjs');
    const provenance = {
      pluginVersion: '2.0.2', agyVersion: '1.2.12', model: 'gemini-3.6-flash-high', effort: 'medium',
      mode: 'print', addDirCount: 0, requestedAt: '2026-09-27T00:00:00.000Z',
    };
    const snapshot = {
      workspaceRoot: 'x', config: {}, needsReview: false, running: [], latestFinished: null,
      recent: [{ id: 'bbbbbbbbbbbb', kind: 'task', status: 'completed', createdAt: 't', updatedAt: 't', completedAt: 't', provenance }],
    };
    const md = renderStatusSnapshot(snapshot);
    assert.match(md, /\| Model \| Effort \|/);
    assert.match(md, /\| gemini-3\.6-flash-high \| medium \|/);
  });
});
