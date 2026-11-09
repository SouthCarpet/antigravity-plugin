/**
 * `review --models a,b` (plan 153 p2, package E, "E1"): the command-level
 * wiring — argv per leg, the shared `request.pairId`, the paired envelope,
 * the exit code rule, and the refusals.
 *
 * `review-compare.mjs`'s own parsing/resolution/comparison functions are
 * unit-tested directly in `tests/review-compare.test.mjs`; this file only
 * proves `review.mjs` wires them correctly.
 *
 * Two layers:
 *   - real runs through `bin/antigravity.mjs` with a fake `agy` (the same
 *     pattern `tests/review-findings.test.mjs` and
 *     `tests/passthrough-argv.test.mjs` use): proves the two leg spawns
 *     carry two distinct `--model` values and the stream-json tail, and
 *     that the two stored job records share `request.pairId` (and a
 *     plain single-model review stores none);
 *   - `review.mjs#run()` driven directly, with its own mocked
 *     `agent-runtime.mjs` (a per-call response queue, since the two legs
 *     need to answer differently) — the paired envelope shape, the
 *     comparison, the halt-on-`auth_required` rule, the exit code rule,
 *     `--check-locations` per leg, and every refusal.
 *
 *   node --test tests/review-models.test.mjs
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { readJobFile } from '../scripts/lib/state.mjs';
import { REVIEW_FINDINGS_SCHEMA_PATH } from '../scripts/lib/review-findings.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
};

const VALID_RESULT_EVENT = `${JSON.stringify({
  event: 'result',
  result: {
    status: 'SUCCESS',
    response: 'ok\n',
    structured_output: { verdict: 'APPROVE', summary: 'ok', findings: [] },
  },
})}\n`;

function runVerb(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

// ---------------------------------------------------------------------------
// Real runs through bin/antigravity.mjs with a fake agy
// ---------------------------------------------------------------------------

describe('review --models: real spawns through bin/antigravity.mjs', () => {
  let stubDir;
  let successAgy;
  let echoAgy;
  const cleanup = [];

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-models-'));
    successAgy = writeFakeAgy(stubDir, 'agy-success', {
      stdout: VALID_RESULT_EVENT, echoArgsStderr: true, exitCode: 0, versionOk: true,
    });
    // exitCode 1: the one status (finishForeground's failure path and this
    // package's buildPairedLeg alike) under which review.mjs echoes the
    // child's own stderr to the outer process, making the real argv
    // observable (the same reason passthrough-argv.test.mjs/
    // review-findings.test.mjs use exitCode 1 for their argv-echo fakes).
    echoAgy = writeFakeAgy(stubDir, 'agy-echo', { echoArgsStderr: true, exitCode: 1, versionOk: true });
  });

  after(() => {
    for (const dir of [stubDir, ...cleanup]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  function freshRepo() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-models-work-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-models-data-'));
    cleanup.push(work, data);
    execSync('git init -q', { cwd: work, stdio: 'ignore', env: GIT_ENV });
    execSync('git commit --allow-empty -q -m init', { cwd: work, stdio: 'ignore', env: GIT_ENV });
    fs.writeFileSync(path.join(work, 'brand-new.txt'), 'never committed\n');
    return { work, data };
  }

  function envFor(agyBin, data) {
    return {
      ...process.env,
      AGY_BIN: agyBin,
      CLAUDE_PLUGIN_DATA: data,
      ANTIGRAVITY_PLUGIN_SESSION_ID: 'models-' + randomBytes(3).toString('hex'),
    };
  }

  // `readJobFile` resolves the state directory off `process.env` in THIS
  // process; the job was written by the CHILD process spawned above, whose
  // own `CLAUDE_PLUGIN_DATA` never touches this process's environment, so
  // the read needs that same variable set here too, temporarily.
  function readJobFileFor(data, work, jobId) {
    const previous = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data;
    try {
      return readJobFile(work, jobId);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }

  it('both legs store the same request.pairId, inputHash, scope, base, and hunks', () => {
    const { work, data } = freshRepo();
    const res = runVerb(
      ['review', '--models', 'gemini-a,gemini-b', '--findings-json', '--json'],
      envFor(successAgy, data), work,
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'paired');
    assert.equal(payload.jobId, null);
    assert.equal(payload.details.jobs.length, 2);
    const [jobA, jobB] = payload.details.jobs.map((j) => readJobFileFor(data, work, j.id));
    assert.equal(jobA.request.pairId, payload.details.pairId);
    assert.equal(jobB.request.pairId, payload.details.pairId);
    assert.equal(jobA.request.pairId, jobB.request.pairId);
    assert.equal(jobA.request.inputHash, jobB.request.inputHash);
    assert.equal(jobA.request.scope, jobB.request.scope);
    assert.equal(jobA.request.base, jobB.request.base);
    assert.deepEqual(jobA.request.hunks, jobB.request.hunks);
    assert.notEqual(jobA.request.model, jobB.request.model);
    assert.equal(jobA.request.model, 'gemini-a');
    assert.equal(jobB.request.model, 'gemini-b');
    assert.equal(jobA.request.mode, 'print');
    assert.equal(jobB.request.mode, 'print');
  });

  it('a single-model review stores no request.pairId at all', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review', '--json'], envFor(successAgy, data), work);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    const stored = readJobFileFor(data, work, payload.jobId);
    assert.equal(Object.hasOwn(stored.request, 'pairId'), false);
  });

  it('both legs still run against the real agy binary when it fails every call', () => {
    const { work, data } = freshRepo();
    const res = runVerb(
      ['review', '--models', 'gemini-a,gemini-b', '--findings-json', '--json'],
      envFor(echoAgy, data), work,
    );
    // The echo fake exits 1 on every call: a run failure (unlike
    // auth_required) never halts the second leg (controller ruling 3), and
    // the command's own exit code is the first non-zero leg's code.
    assert.equal(res.status, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'paired');
    assert.equal(payload.details.jobs[0].status, 'failed');
    assert.equal(payload.details.jobs[1].status, 'failed');
    const [jobA, jobB] = payload.details.jobs.map((j) => readJobFileFor(data, work, j.id));
    assert.equal(jobA.request.model, 'gemini-a');
    assert.equal(jobB.request.model, 'gemini-b');
  });

  it('--models with --check-locations runs one check per leg', () => {
    const { work, data } = freshRepo();
    const res = runVerb(
      ['review', '--models', 'gemini-a,gemini-b', '--findings-json', '--check-locations', '--json'],
      envFor(successAgy, data), work,
    );
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    for (const job of payload.details.jobs) {
      assert.equal(job.locationCheck.heuristic, true);
    }
  });
});

// ---------------------------------------------------------------------------
// run() driven in-process, with a per-call mocked agent-runtime
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

const agyRuntime = {
  calls: [], responses: [],
  probeModels: { ok: false, reason: 'not scripted' },
  probeAgyResult: { ok: true, version: 'test' },
};
mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      const index = agyRuntime.calls.length;
      agyRuntime.calls.push(opts);
      const response = agyRuntime.responses[index] ?? agyRuntime.responses.at(-1) ?? { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
      return { ...response };
    },
    resolveAgyBin: () => 'agy',
    probeAgyModels: async () => agyRuntime.probeModels,
    probeAgy: async () => agyRuntime.probeAgyResult,
    DEFAULT_AGY_BIN: 'agy',
  },
});

function makeTempCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-models-run-'));
}

function initEmptyGitRepo(cwd) {
  execSync('git init -q', { cwd, stdio: 'ignore', env: GIT_ENV });
  execSync('git commit --allow-empty -q -m init', { cwd, stdio: 'ignore', env: GIT_ENV });
  return GIT_ENV;
}

function setPluginDataEnv(dir) {
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'test-' + randomBytes(3).toString('hex');
}

function captureStdio() {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return origStdout(chunk, ...rest);
    out.push(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  return {
    out, err,
    restore: () => { process.stdout.write = origStdout; process.stderr.write = origStderr; },
  };
}

function findingResult(findings) {
  return {
    status: 'completed', exitCode: 0,
    stdout: 'ok',
    stderr: '',
    structured: { verdict: 'CHANGES_REQUESTED', summary: 's', findings },
  };
}

function finding(overrides = {}) {
  return {
    severity: 'high', file: 'a.txt', line: 1, description: 'd', recommendation: 'r',
    ...overrides,
  };
}

let tempDir;
beforeEach(() => {
  tempDir = makeTempCwd();
  setPluginDataEnv(tempDir);
  agyRuntime.calls = [];
  agyRuntime.responses = [];
  agyRuntime.probeModels = { ok: false, reason: 'not scripted' };
});
afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
after(() => {
  Object.assign(process.env, ORIGINAL_ENV);
});

function prepareTrackedChange(cwd) {
  const gitEnv = initEmptyGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'original\n');
  execSync('git add a.txt', { cwd, stdio: 'ignore', env: gitEnv });
  execSync('git commit -q -m add', { cwd, stdio: 'ignore', env: gitEnv });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'edited\nmore\n');
}

describe('/antigravity:review --models (in-process)', () => {
  describe('conflicts (controller ruling 2)', () => {
    const pairs = [
      ['--model', 'gemini-x'],
      ['--model-alias', 'flash'],
      ['--background'],
      ['--wait'],
      ['--continue'],
      ['--conversation', 'abc'],
      ['--show-result'],
      ['--preview'],
    ];
    for (const extra of pairs) {
      it(`refuses --models combined with ${extra[0]}`, async () => {
        const { run } = await import('../scripts/commands/review.mjs');
        const cap = captureStdio();
        let exit;
        try {
          exit = await run(['--models', 'a,b', '--findings-json', ...extra], { cwd: tempDir });
        } finally {
          cap.restore();
        }
        assert.equal(exit, 1);
        assert.match(cap.err.join(''), new RegExp(`cannot combine --models and --${extra[0].slice(2)}`));
      });
    }
  });

  it('refuses --models without --findings-json', async () => {
    prepareTrackedChange(tempDir);
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 1);
    assert.equal(cap.err.join(''), 'antigravity:review — --models needs --findings-json to compare structured findings\n');
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('refuses a malformed --models value before any spawn', async () => {
    prepareTrackedChange(tempDir);
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a', '--findings-json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /exactly two/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('refuses an unknown alias family before any spawn of the review itself', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.probeModels = { ok: true, text: 'gemini-flash-3.8-medium\tFlash\n' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'alias:nope,gemini-b', '--findings-json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /unknown model alias/);
    assert.equal(agyRuntime.calls.length, 0, 'no leg spawns once resolution fails');
  });

  it('refuses before any spawn when agy itself is absent', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.probeAgyResult = { ok: false, reason: 'not found' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b', '--findings-json'], { cwd: tempDir }); }
    finally {
      cap.restore();
      agyRuntime.probeAgyResult = { ok: true, version: 'test' };
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /not on PATH/);
    assert.equal(agyRuntime.calls.length, 0, 'no leg spawns when agy itself cannot be probed');
  });

  it('runs both legs when the first leg returns valid findings, comparing them', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.responses = [
      findingResult([finding({ line: 2 })]),
      findingResult([finding({ line: 2, severity: 'low' })]),
    ];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b', '--findings-json', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls.length, 2);
    // Every argv-determining field `runAgyPrint` receives for each leg,
    // asserted in full: two fresh-conversation calls, differing only in
    // `model` (the brief's "two print-mode calls with the two distinct
    // models, full argv").
    const argvFields = (call) => ({
      model: call.model, effort: call.effort, mode: call.mode, conversationId: call.conversationId,
      addDirs: call.addDirs, outputFormat: call.outputFormat, extraArgs: call.extraArgs,
      jsonSchemaPath: call.jsonSchemaPath,
    });
    assert.deepEqual(argvFields(agyRuntime.calls[0]), {
      model: 'gemini-a', effort: undefined, mode: 'print', conversationId: undefined,
      addDirs: [], outputFormat: undefined, extraArgs: [], jsonSchemaPath: REVIEW_FINDINGS_SCHEMA_PATH,
    });
    assert.deepEqual(argvFields(agyRuntime.calls[1]), {
      model: 'gemini-b', effort: undefined, mode: 'print', conversationId: undefined,
      addDirs: [], outputFormat: undefined, extraArgs: [], jsonSchemaPath: REVIEW_FINDINGS_SCHEMA_PATH,
    });
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.status, 'paired');
    assert.equal(payload.details.jobs[0].findingsStatus, 'valid');
    assert.equal(payload.details.jobs[1].findingsStatus, 'valid');
    assert.ok(payload.details.comparison);
    assert.equal(payload.details.comparison.bothFlagged.length, 1);
    assert.equal(payload.details.comparison.onlyA.length, 0);
    assert.equal(payload.details.comparison.onlyB.length, 0);
  });

  it('comparison is null when one leg has invalid findings, but the second leg still runs', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.responses = [
      { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '', structured: 'not json {' },
      findingResult([finding()]),
    ];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b', '--findings-json', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls.length, 2, 'a findings failure on leg A still lets leg B run');
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.jobs[0].findingsStatus, 'invalid');
    assert.equal(payload.details.jobs[1].findingsStatus, 'valid');
    assert.equal(payload.details.comparison, null);
  });

  it('a model/run failure on leg A still lets leg B run; exit code is the first non-zero leg', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.responses = [
      { status: 'failed', exitCode: 1, stdout: '', stderr: 'boom' },
      findingResult([finding()]),
    ];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b', '--findings-json', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(agyRuntime.calls.length, 2);
    assert.equal(exit, 1);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.jobs[0].status, 'failed');
    assert.equal(payload.details.jobs[1].status, 'completed');
  });

  it('auth_required on leg A halts before leg B ever spawns', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.responses = [
      { status: 'auth_required', exitCode: 1, stdout: '', stderr: '' },
    ];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b', '--findings-json', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(agyRuntime.calls.length, 1, 'leg B never spawns once leg A needs sign-in');
    assert.equal(exit, 1);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.jobs[0].status, 'auth_required');
    assert.equal(payload.details.jobs[1].status, 'not_run');
    assert.equal(payload.details.jobs[1].id, null);
    assert.equal(payload.details.comparison, null);
  });

  it('a cancelled leg yields exit code 2', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.responses = [
      { status: 'cancelled', exitCode: 130, stdout: '', stderr: '' },
      findingResult([finding()]),
    ];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--models', 'gemini-a,gemini-b', '--findings-json', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 2);
  });

  it('prints the two-calls cost notice once, before either leg', async () => {
    prepareTrackedChange(tempDir);
    agyRuntime.responses = [findingResult([finding()]), findingResult([finding()])];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    try { await run(['--models', 'gemini-a,gemini-b', '--findings-json', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    const noticeLines = cap.err.join('').split('\n').filter((l) => l.includes('two model calls will run'));
    assert.equal(noticeLines.length, 1);
  });
});
