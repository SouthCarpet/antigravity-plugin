/**
 * `result <job-id> --check-current` (3.2.0, package C, item C2).
 *
 * Real `review` jobs are made with a mocked agy answer in a real git
 * repository, then the repository is changed and the check is run. The job
 * records are never written by the check, and the only process it spawns is
 * git.
 *
 *   node --test --experimental-test-module-mocks tests/result-check-current.test.mjs
 */
import { test, mock, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStdio } from './helpers/capture-stdio.mjs';

const agy = { calls: [] };
mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      agy.calls.push(opts);
      return { status: 'completed', exitCode: 0, stdout: 'Verdict: APPROVE', stderr: '', usage: null, durationSeconds: 1 };
    },
    resolveAgyBin: () => 'agy',
    probeAgyModels: async () => ({ ok: false, reason: 'not scripted' }),
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

// Record every process the plugin code spawns after this point, and pass the call through.
const spawned = [];
const record = (name) => (command, ...rest) => {
  spawned.push({ name, command: String(command) });
  return realChildProcess[name](command, ...rest);
};
const wrapped = { ...realChildProcess };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrapped[name] = record(name);
mock.module('node:child_process', { namedExports: wrapped, defaultExport: wrapped });

// Imported after the mock: these modules reach git.mjs, which must see the recording spawn functions.
const { upsertJob, writeJobFile, readJobFile } = await import('../scripts/lib/state.mjs');
const { resetWorkspaceRootCache } = await import('../scripts/lib/workspace.mjs');
const { run: reviewRun } = await import('../scripts/commands/review.mjs');
const { run: resultRun } = await import('../scripts/commands/result.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
};
const saved = { data: process.env.CLAUDE_PLUGIN_DATA, session: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID };
let root;
let repo;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}
const put = (name, text) => fs.writeFileSync(path.join(repo, name), text);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'check-current-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, 'data');
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'check-current-session';
  resetWorkspaceRootCache();
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  put('a.txt', 'one\ntwo\nthree\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  agy.calls = [];
});
afterEach(() => {
  for (const [key, value] of [['CLAUDE_PLUGIN_DATA', saved.data], ['ANTIGRAVITY_PLUGIN_SESSION_ID', saved.session]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function capture(fn) {
  const cap = captureStdio();
  let code;
  try {
    code = await fn();
  } finally {
    cap.restore();
  }
  return { code, out: cap.out.join(''), err: cap.err.join('') };
}

async function review(...args) {
  const r = await capture(() => reviewRun([...args, '--json'], { cwd: repo }));
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out).jobId;
}

async function check(jobId, ...extra) {
  const r = await capture(() => resultRun([jobId, '--check-current', '--json', ...extra], { cwd: repo }));
  return { ...r, payload: r.out ? JSON.parse(r.out) : null };
}

const statusOf = async (jobId) => (await check(jobId)).payload.details.checkCurrent;

function stateSnapshot() {
  const files = new Map();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, fs.readFileSync(full));
    }
  };
  walk(path.join(root, 'data'));
  return files;
}

// Oracle: plan C2. match / changed / unknown against the same scope, base, focus and normalization as the review.
describe('working-tree scope', () => {
  test('match: nothing changed since the review', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    const check1 = await statusOf(id);
    assert.equal(check1.status, 'match');
    assert.equal('reason' in check1, false);
    assert.match(check1.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test('changed: the diff changed after the review', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    put('a.txt', 'one\nTWO\nTHREE\n');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('changed: the change was committed after the review', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    git('commit', '-q', '-am', 'take the change');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('changed: the same text with CRLF line endings is a different review input', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    put('a.txt', 'one\r\nTWO\r\nthree\r\n');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('match: an untracked-only review is matched again', async () => {
    put('new.txt', 'hello\nworld\n');
    const id = await review();
    assert.equal((await statusOf(id)).status, 'match');
  });

  test('changed: the content of an untracked file changed', async () => {
    put('new.txt', 'hello\nworld\n');
    const id = await review();
    put('new.txt', 'hello\nthere\n');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('changed: the untracked file is gone', async () => {
    put('new.txt', 'hello\n');
    const id = await review();
    fs.rmSync(path.join(repo, 'new.txt'));
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('match: the same --focus text is read from the record', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review('--focus', 'error handling');
    assert.equal((await statusOf(id)).status, 'match');
    assert.equal(readJobFile(repo, id).request.focus, 'error handling');
  });

  test('match: a review with --findings-json is checked with the findings flag', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review('--findings-json');
    assert.equal(readJobFile(repo, id).request.findingsJson, true);
    assert.equal((await statusOf(id)).status, 'match');
  });

  test('match: a stored base on a working-tree review is read again and still resolves', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review('--base', 'main');
    assert.equal(readJobFile(repo, id).request.scope, 'working-tree');
    assert.equal((await statusOf(id)).status, 'match');
  });
});

describe('branch scope', () => {
  beforeEach(() => {
    git('checkout', '-q', '-b', 'feature');
    put('a.txt', 'one\ntwo\nthree\nfour\n');
    git('commit', '-q', '-am', 'feature work');
  });

  test('match with an explicit --base', async () => {
    const id = await review('--scope', 'branch', '--base', 'main');
    const request = readJobFile(repo, id).request;
    assert.equal(request.scope, 'branch');
    assert.equal(request.base, 'main');
    assert.equal((await statusOf(id)).status, 'match');
  });

  test('changed: a new commit on the branch', async () => {
    const id = await review('--scope', 'branch', '--base', 'main');
    put('a.txt', 'one\ntwo\nthree\nfour\nfive\n');
    git('commit', '-q', '-am', 'more work');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('changed: the base ref moved', async () => {
    const id = await review('--scope', 'branch', '--base', 'main');
    git('checkout', '-q', 'main');
    put('b.txt', 'base moved\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main moves');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('unknown (base_not_found): the base ref no longer resolves', async () => {
    git('branch', 'old-base', 'main');
    const id = await review('--scope', 'branch', '--base', 'old-base');
    git('branch', '-q', '-D', 'old-base');
    const result = await check(id);
    assert.equal(result.code, 0);
    assert.equal(result.payload.details.checkCurrent.status, 'unknown');
    assert.equal(result.payload.details.checkCurrent.reason, 'base_not_found');
  });

  // Decision (ruling 2): a stored base of null on a branch review means the default base is resolved again today.
  test('match: a branch review with the default base (stored null) resolves main again', async () => {
    const id = await review();
    const request = readJobFile(repo, id).request;
    assert.equal(request.scope, 'branch');
    assert.equal(request.base, null);
    assert.equal((await statusOf(id)).status, 'match');
  });

  test('changed: the default base moved', async () => {
    const id = await review();
    git('checkout', '-q', 'main');
    put('b.txt', 'base moved\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main moves');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    assert.equal((await statusOf(id)).status, 'changed');
  });

  test('the default base falls back to master when main is gone', async () => {
    git('branch', '-m', 'main', 'master');
    const id = await review();
    assert.equal((await statusOf(id)).status, 'match');
  });

  test('unknown (default_base_not_found): neither main nor master resolves', async () => {
    const id = await review();
    git('branch', '-m', 'main', 'trunk');
    const result = (await statusOf(id));
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'default_base_not_found');
  });
});

describe('unknown', () => {
  async function writeReview(id, request, status = 'completed') {
    await upsertJob(repo, { id, kind: 'review', status });
    await writeJobFile(repo, id, { id, kind: 'review', status, request, result: { rawOutput: 'ok' } });
    return id;
  }

  test('legacy record without inputHash (legacy_record)', async () => {
    const id = await writeReview('a1a1a1a1a1a1', { scope: 'working-tree' });
    const result = await check(id);
    assert.equal(result.code, 0);
    assert.equal(result.payload.details.checkCurrent.status, 'unknown');
    assert.equal(result.payload.details.checkCurrent.reason, 'legacy_record');
  });

  for (const [name, request] of [
    ['no scope', { inputHash: 'abc' }],
    ['an unresolved scope', { inputHash: 'abc', scope: 'auto' }],
    ['a base that is not a string', { inputHash: 'abc', scope: 'branch', base: 7 }],
    ['an empty hash', { inputHash: '', scope: 'working-tree' }],
  ]) {
    test(`record with ${name} is unknown (legacy_record)`, async () => {
      const id = await writeReview('b2b2b2b2b2b2', request);
      assert.equal((await statusOf(id)).reason, 'legacy_record');
    });
  }

  test('unknown (collection_failed): the workspace is not a git repository any more', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    resetWorkspaceRootCache();
    const result = await statusOf(id);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'collection_failed');
  });

  test('a review job that is not finished is refused like result refuses it, and nothing is checked', async () => {
    const id = await writeReview('c3c3c3c3c3c3', { inputHash: 'abc', scope: 'working-tree', base: null }, 'running');
    spawned.length = 0;
    const result = await check(id);
    assert.equal(result.code, 1);
    assert.equal(result.payload.status, 'state_error');
    assert.match(result.err, /is still running/);
    assert.equal('checkCurrent' in result.payload.details, false);
    assert.equal(spawned.length, 0);
  });
});

describe('job kinds', () => {
  for (const kind of ['task', 'rescue', 'vision', 'media']) {
    test(`a ${kind} job gets invalid_input / check_current_unsupported_kind`, async () => {
      const id = 'd4d4d4d4d4d4';
      await upsertJob(repo, { id, kind, status: 'completed' });
      await writeJobFile(repo, id, { id, kind, status: 'completed', request: {}, result: { rawOutput: 'done' } });
      spawned.length = 0;
      const result = await check(id);
      assert.equal(result.code, 1);
      assert.equal(result.payload.status, 'invalid_input');
      assert.equal(result.payload.jobId, id);
      assert.deepEqual(result.payload.details.error, {
        code: 'check_current_unsupported_kind',
        phase: 'validate',
        message: `--check-current applies only to review jobs; job ${id} is a ${kind} job.`,
      });
      assert.equal(result.err, `antigravity:result — --check-current applies only to review jobs; job ${id} is a ${kind} job.\n`);
      assert.equal(spawned.length, 0);
    });
  }
});

describe('a record from the next package', () => {
  // Package E stores `request.pairId` on both jobs of a `review --models` call. Each job is a review job like any other.
  test('a stored record with request.pairId is checked on its own, not refused', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    const record = readJobFile(repo, id);
    await writeJobFile(repo, id, { ...record, request: { ...record.request, pairId: 'pair-1234' } });
    assert.equal((await statusOf(id)).status, 'match');
    put('a.txt', 'one\nTWO\nTHREE\n');
    assert.equal((await statusOf(id)).status, 'changed');
  });
});

describe('output and safety', () => {
  test('the check line goes to stderr and into the markdown, after the answer, and --json carries details.checkCurrent', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    const text = await capture(() => resultRun([id, '--check-current'], { cwd: repo }));
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /^Verdict: APPROVE\nantigravity:result — currentness check \(snapshot\): match\.\n/);
    assert.ok(text.err.includes('antigravity:result — currentness check (snapshot): match.\n'), text.err);
    const json = await check(id);
    assert.deepEqual(Object.keys(json.payload.details.checkCurrent), ['status', 'checkedAt']);
    put('a.txt', 'changed\n');
    const unknownLine = await capture(() => resultRun([id, '--check-current'], { cwd: repo }));
    assert.match(unknownLine.out, /currentness check \(snapshot\): changed\.\n/);
  });

  test('an unknown result names the reason in the line', async () => {
    await upsertJob(repo, { id: 'e5e5e5e5e5e5', kind: 'review', status: 'completed' });
    await writeJobFile(repo, 'e5e5e5e5e5e5', { id: 'e5e5e5e5e5e5', kind: 'review', status: 'completed', request: {}, result: { rawOutput: 'ok' } });
    const text = await capture(() => resultRun(['e5e5e5e5e5e5', '--check-current'], { cwd: repo }));
    assert.ok(text.err.includes('antigravity:result — currentness check (snapshot): unknown (legacy_record).\n'), text.err);
  });

  test('without the flag the output has no checkCurrent key and no extra line', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    const json = await capture(() => resultRun([id, '--json'], { cwd: repo }));
    assert.equal('checkCurrent' in JSON.parse(json.out).details, false);
    const text = await capture(() => resultRun([id], { cwd: repo }));
    assert.doesNotMatch(text.out + text.err, /currentness/);
  });

  test('the check writes nothing: every state file is byte for byte the same, and agy is not called', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    put('a.txt', 'changed\n');
    const before = stateSnapshot();
    const callsBefore = agy.calls.length;
    for (const status of ['changed', 'changed']) {
      assert.equal((await statusOf(id)).status, status);
    }
    const after = stateSnapshot();
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [file, bytes] of before) assert.deepEqual(after.get(file), bytes, file);
    assert.equal(agy.calls.length, callsBefore);
  });

  test('the only process spawned is git', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    spawned.length = 0;
    await statusOf(id);
    assert.ok(spawned.length > 0);
    assert.deepEqual([...new Set(spawned.map((entry) => entry.command))], ['git']);
  });

  test('the check works with agy absent: AGY_BIN points at nothing', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    const old = process.env.AGY_BIN;
    process.env.AGY_BIN = path.join(root, 'no-such-agy');
    try {
      assert.equal((await statusOf(id)).status, 'match');
    } finally {
      if (old === undefined) delete process.env.AGY_BIN;
      else process.env.AGY_BIN = old;
    }
  });

  test('--check-current combines with --check-locations, --head and --tail', async () => {
    put('a.txt', 'one\nTWO\nthree\n');
    const id = await review();
    const result = await check(id, '--check-locations', '--head', '1');
    assert.equal(result.code, 0, result.err);
    assert.equal(result.payload.details.checkCurrent.status, 'match');
    assert.ok('locationCheck' in result.payload.details);
  });
});
