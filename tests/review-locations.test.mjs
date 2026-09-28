/**
 * `review --check-locations` / `result --check-locations` (Task 14, "Senate
 * R8", 2026-09): the heuristic citation-location check.
 *
 * Layers:
 *   - `checkReviewLocations` itself: in/outside/unknown classification,
 *     version-string and URL exclusion, Windows separators, a range
 *     citation, the legacy (`hunks` missing) `null` path;
 *   - hunk parsing (`parseDiffHunks`, `review-input.mjs`) off a real
 *     unified diff string, and off untracked whole files through
 *     `buildReviewInput`;
 *   - `review.mjs` foreground, with a mocked `runAgyPrint` answer naming
 *     all three citation kinds, and a full-argv check that the flag adds
 *     nothing to what reaches agy;
 *   - `result.mjs` on a directly-written background job, including the
 *     legacy job (no stored `request.hunks`) path.
 *
 *   node --test tests/review-locations.test.mjs
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  checkReviewLocations,
  locationCheckSummaryLine,
  locationCheckUnavailableLine,
  locationCheckReportLine,
} from '../scripts/lib/review-locations.mjs';
import { parseDiffHunks, buildReviewInput } from '../scripts/lib/review-input.mjs';
import { upsertJob, writeJobFile, resolveJobFile } from '../scripts/lib/state.mjs';

const ORIGINAL_ENV = { ...process.env };

// Registered before review.mjs (or its job-helpers.mjs dependency) is ever
// imported below — see tests/commands.test.mjs's own module doc comment for
// why this must happen at module top level, before any dynamic import.
const agyRuntime = {
  next: { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' },
  calls: [],
};
mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      agyRuntime.calls.push(opts);
      return { ...agyRuntime.next };
    },
    resolveAgyBin: () => 'agy',
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

// ---------------------------------------------------------------------------
// checkReviewLocations
// ---------------------------------------------------------------------------

describe('checkReviewLocations', () => {
  const hunks = [
    { path: 'src/app.py', newStart: 8, newEnd: 20 },
    { path: 'docs/readme.md', newStart: 1, newEnd: 5 },
  ];

  it('classifies a citation inside a hunk as in_diff', () => {
    const result = checkReviewLocations('See src/app.py:10 for the fix.', hunks);
    assert.deepEqual(result.citations, [{ text: 'src/app.py:10', path: 'src/app.py', line: 10, state: 'in_diff' }]);
    assert.deepEqual(result.counts, { in_diff: 1, outside_diff: 0, unknown_path: 0 });
    assert.equal(result.heuristic, true);
  });

  it('classifies a citation on a known path but outside every hunk as outside_diff', () => {
    const result = checkReviewLocations('See src/app.py:99 elsewhere.', hunks);
    assert.deepEqual(result.citations, [{ text: 'src/app.py:99', path: 'src/app.py', line: 99, state: 'outside_diff' }]);
    assert.deepEqual(result.counts, { in_diff: 0, outside_diff: 1, unknown_path: 0 });
  });

  it('classifies a citation on a path no hunk names as unknown_path', () => {
    const result = checkReviewLocations('See unrelated/file.js:3 too.', hunks);
    assert.deepEqual(result.citations, [{ text: 'unrelated/file.js:3', path: 'unrelated/file.js', line: 3, state: 'unknown_path' }]);
    assert.deepEqual(result.counts, { in_diff: 0, outside_diff: 0, unknown_path: 1 });
  });

  it('a range citation (a:10-12) is in_diff only when the whole range fits one hunk', () => {
    const fits = checkReviewLocations('src/app.py:10-12 looks fine.', hunks);
    assert.deepEqual(fits.citations, [{ text: 'src/app.py:10-12', path: 'src/app.py', line: 10, state: 'in_diff' }]);

    const spillsOver = checkReviewLocations('src/app.py:18-25 spills past the hunk.', hunks);
    assert.equal(spillsOver.citations[0].state, 'outside_diff');
  });

  it('excludes a bare three-part version string from citations', () => {
    const result = checkReviewLocations('Bumped agy to 1.2.11:5 today.', hunks);
    assert.deepEqual(result.citations, []);
    assert.deepEqual(result.counts, { in_diff: 0, outside_diff: 0, unknown_path: 0 });
  });

  it('excludes a http(s):// URL whose path segment looks like path:line', () => {
    const result = checkReviewLocations(
      'See https://example.com/blob/main/app.py:42 and http://x.py:5 for context.',
      hunks,
    );
    assert.deepEqual(result.citations, []);
  });

  it('a bare host:port with no http(s):// prefix is not excluded (out of tuning scope)', () => {
    const result = checkReviewLocations('Connect to example.com:8080 for the API.', hunks);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].state, 'unknown_path');
  });

  it('normalizes a Windows-separated citation path before matching a hunk', () => {
    const result = checkReviewLocations('Windows path src\\app.py:9 also cites the change.', hunks);
    assert.deepEqual(result.citations, [{ text: 'app.py:9', path: 'app.py', line: 9, state: 'unknown_path' }]);
  });

  it('normalizes a leading ./, a/, or b/ on both the citation and the hunk path', () => {
    const result = checkReviewLocations('See ./src/app.py:10 and a/docs/readme.md:2 here.', [
      { path: 'a/src/app.py', newStart: 8, newEnd: 20 },
      { path: 'b/docs/readme.md', newStart: 1, newEnd: 5 },
    ]);
    assert.deepEqual(result.counts, { in_diff: 2, outside_diff: 0, unknown_path: 0 });
  });

  it('returns null (not an empty result) when hunks is not an array', () => {
    assert.equal(checkReviewLocations('src/app.py:10', undefined), null);
    assert.equal(checkReviewLocations('src/app.py:10', null), null);
  });

  it('an empty hunks array still runs the check and reports unknown_path', () => {
    const result = checkReviewLocations('src/app.py:10', []);
    assert.deepEqual(result.counts, { in_diff: 0, outside_diff: 0, unknown_path: 1 });
  });

  it('a non-string answer is treated as empty', () => {
    assert.deepEqual(checkReviewLocations(null, hunks).citations, []);
  });
});

describe('location check report lines', () => {
  it('locationCheckSummaryLine formats the counts in order', () => {
    assert.equal(
      locationCheckSummaryLine('review', { in_diff: 2, outside_diff: 1, unknown_path: 3 }),
      'antigravity:review — location check (heuristic): 2 in diff, 1 outside diff, 3 unknown paths.',
    );
  });

  it('locationCheckUnavailableLine names the verb and the reason', () => {
    assert.equal(
      locationCheckUnavailableLine('result'),
      'antigravity:result — location check unavailable: this job predates hunk storage.',
    );
  });

  it('locationCheckReportLine picks the summary line for a result, the unavailable line for null', () => {
    const check = checkReviewLocations('src/app.py:10', [{ path: 'src/app.py', newStart: 1, newEnd: 20 }]);
    assert.equal(locationCheckReportLine('review', check), locationCheckSummaryLine('review', check.counts));
    assert.equal(locationCheckReportLine('review', null), locationCheckUnavailableLine('review'));
  });
});

// ---------------------------------------------------------------------------
// Hunk parsing (review-input.mjs)
// ---------------------------------------------------------------------------

describe('parseDiffHunks (Task 14, "Senate R8")', () => {
  it('parses newStart/newEnd off @@ headers, across files, one hunk per header', () => {
    const diff = [
      'diff --git a/src/app.py b/src/app.py',
      'index 111..222 100644',
      '--- a/src/app.py',
      '+++ b/src/app.py',
      '@@ -5,2 +5,3 @@',
      '-old',
      '+new1',
      '+new2',
      ' context',
      '@@ -20 +21 @@',
      '-oldline',
      '+newline',
      'diff --git a/other.js b/other.js',
      'index 333..444 100644',
      '--- a/other.js',
      '+++ b/other.js',
      '@@ -1 +1,2 @@',
      '+first',
      '+second',
    ].join('\n') + '\n';

    assert.deepEqual(parseDiffHunks(diff), [
      { path: 'src/app.py', newStart: 5, newEnd: 7 },
      { path: 'src/app.py', newStart: 21, newEnd: 21 },
      { path: 'other.js', newStart: 1, newEnd: 2 },
    ]);
  });

  it('a pure-deletion hunk (+c,0) contributes no hunk', () => {
    const diff = [
      'diff --git a/deleted.txt b/deleted.txt',
      'deleted file mode 100644',
      '--- a/deleted.txt',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-a',
      '-b',
      '-c',
    ].join('\n') + '\n';
    assert.deepEqual(parseDiffHunks(diff), []);
  });

  it('a non-string/empty diff yields no hunks', () => {
    assert.deepEqual(parseDiffHunks(''), []);
    assert.deepEqual(parseDiffHunks(undefined), []);
  });
});

describe('buildReviewInput — hunks (Task 14, "Senate R8")', () => {
  it('every included untracked file becomes one { newStart: 1, newEnd: <line count> } hunk', () => {
    const envelope = {
      scope: 'working-tree',
      context: {
        diff: '',
        untrackedContents: [
          { path: 'new-file.txt', content: 'line1\nline2\nline3\n' },
          { path: 'no-trailing-newline.txt', content: 'only line' },
          { path: 'skip-me.bin', skipped: 'binary' },
        ],
      },
    };
    assert.deepEqual(buildReviewInput(envelope).hunks, [
      { path: 'new-file.txt', newStart: 1, newEnd: 3 },
      { path: 'no-trailing-newline.txt', newStart: 1, newEnd: 1 },
    ]);
  });

  it('a branch-scope envelope carries diff hunks but never untracked hunks', () => {
    const envelope = {
      scope: 'branch',
      context: {
        diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1,2 @@\n+one\n+two\n',
        untrackedContents: [{ path: 'ignored.txt', content: 'x\n' }],
      },
    };
    assert.deepEqual(buildReviewInput(envelope).hunks, [{ path: 'x.js', newStart: 1, newEnd: 2 }]);
  });

  it('hunks is stored unconditionally, with or without findingsJson/focus', () => {
    const envelope = { scope: 'working-tree', context: { diff: '', untrackedContents: [] } };
    assert.deepEqual(buildReviewInput(envelope).hunks, []);
    assert.deepEqual(buildReviewInput(envelope, { findingsJson: true }).hunks, []);
  });
});

// ---------------------------------------------------------------------------
// review.mjs / result.mjs end to end
// ---------------------------------------------------------------------------

const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function makeTempCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-locations-test-'));
}

function initEmptyGitRepo(cwd) {
  const env = { ...process.env, ...GIT_TEST_ENV };
  execSync('git init -q', { cwd, stdio: 'ignore', env });
  execSync('git commit --allow-empty -q -m init', { cwd, stdio: 'ignore', env });
  return env;
}

function setPluginDataEnv(dir) {
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'test-session-' + randomBytes(3).toString('hex');
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
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return origStderr(chunk, ...rest);
    err.push(chunk);
    return true;
  };
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

function parseEnvelope(chunks) {
  return JSON.parse(chunks.join(''));
}

let tempDir;
beforeEach(() => {
  tempDir = makeTempCwd();
  setPluginDataEnv(tempDir);
  agyRuntime.calls = [];
});
afterEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_ENV.CLAUDE_PLUGIN_DATA ?? '';
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const ANSWER_WITH_ALL_THREE_KINDS = [
  '## Findings',
  '- `src/app.py:2` looks correct (in the diff).',
  '- `src/app.py:99` is unrelated context (outside the diff).',
  '- `unrelated/other.js:1` is a pre-existing issue (path not in the diff).',
].join('\n');

describe('review --check-locations (foreground, Task 14, "Senate R8")', () => {
  it('reports details.locationCheck, one stderr line, and appends the line to markdown', async () => {
    initEmptyGitRepo(tempDir);
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'app.py'), 'one\ntwo\nthree\n');
    execSync('git add -A', { cwd: tempDir, stdio: 'ignore', env: { ...process.env, ...GIT_TEST_ENV } });
    execSync('git commit -q -m base', { cwd: tempDir, stdio: 'ignore', env: { ...process.env, ...GIT_TEST_ENV } });
    fs.writeFileSync(path.join(tempDir, 'src', 'app.py'), 'one\nTWO-CHANGED\nthree\n');

    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: ANSWER_WITH_ALL_THREE_KINDS, stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--check-locations', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out);
    assert.equal(payload.answer, ANSWER_WITH_ALL_THREE_KINDS);
    assert.equal(payload.details.locationCheck.heuristic, true);
    assert.deepEqual(payload.details.locationCheck.counts, { in_diff: 1, outside_diff: 1, unknown_path: 1 });

    const expectedLine = 'antigravity:review — location check (heuristic): 1 in diff, 1 outside diff, 1 unknown paths.';
    assert.ok(cap.err.some((line) => line.includes(expectedLine)), cap.err.join(''));
  });

  it('markdown mode appends the same line after the answer, and answer text is unaffected', async () => {
    initEmptyGitRepo(tempDir);
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'app.py'), 'one\ntwo\nthree\n');
    execSync('git add -A', { cwd: tempDir, stdio: 'ignore', env: { ...process.env, ...GIT_TEST_ENV } });
    execSync('git commit -q -m base', { cwd: tempDir, stdio: 'ignore', env: { ...process.env, ...GIT_TEST_ENV } });
    fs.writeFileSync(path.join(tempDir, 'src', 'app.py'), 'one\nTWO-CHANGED\nthree\n');

    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: ANSWER_WITH_ALL_THREE_KINDS, stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--check-locations'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.ok(text.startsWith(ANSWER_WITH_ALL_THREE_KINDS));
    assert.match(text, /antigravity:review — location check \(heuristic\): 1 in diff, 1 outside diff, 1 unknown paths\.$/m);
  });

  it('without the flag, details carries no locationCheck key and the markdown is unchanged', async () => {
    initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'brand-new.txt'), 'hello\n');

    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'plain review text', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out);
    assert.equal('locationCheck' in payload.details, false);
  });

  it('full-argv proof: --check-locations adds nothing to what reaches agy', async () => {
    initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'brand-new.txt'), 'hello\n');

    function argShape(opts) {
      const { mode, conversationId, addDirs, model, effort, outputFormat, extraArgs, jsonSchemaPath } = opts;
      return { mode, conversationId, addDirs, model, effort, outputFormat, extraArgs, jsonSchemaPath };
    }

    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');

    agyRuntime.calls = [];
    let cap = captureStdio();
    try { await run(['--json'], { cwd: tempDir }); } finally { cap.restore(); }
    const withoutFlag = argShape(agyRuntime.calls.at(-1));

    agyRuntime.calls = [];
    cap = captureStdio();
    try { await run(['--check-locations', '--json'], { cwd: tempDir }); } finally { cap.restore(); }
    const withFlag = argShape(agyRuntime.calls.at(-1));

    assert.deepEqual(withFlag, withoutFlag);
    assert.deepEqual(withFlag.extraArgs, []);
    assert.equal(withFlag.jsonSchemaPath, undefined);
  });
});

describe('result --check-locations (Task 14, "Senate R8")', () => {
  it('checks a stored job written without the flag, since hunks are always stored', async () => {
    const id = '123456abcdef';
    const hunks = [{ path: 'src/app.py', newStart: 1, newEnd: 5 }];
    await upsertJob(tempDir, { id, kind: 'review', status: 'completed' });
    await writeJobFile(tempDir, id, {
      id, kind: 'review', status: 'completed',
      request: { hunks },
      result: { rawOutput: 'src/app.py:2 is fine; unrelated/x.js:9 is not in the diff.' },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--check-locations', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out);
    assert.deepEqual(payload.details.locationCheck.counts, { in_diff: 1, outside_diff: 0, unknown_path: 1 });
    assert.ok(
      cap.err.some((line) => line.includes('antigravity:result — location check (heuristic): 1 in diff, 0 outside diff, 1 unknown paths.')),
      cap.err.join(''),
    );
  });

  it('without the flag, a job with stored hunks carries no locationCheck key', async () => {
    const id = '223456abcdef';
    await upsertJob(tempDir, { id, kind: 'review', status: 'completed' });
    await writeJobFile(tempDir, id, {
      id, kind: 'review', status: 'completed',
      request: { hunks: [{ path: 'src/app.py', newStart: 1, newEnd: 5 }] },
      result: { rawOutput: 'src/app.py:2 is fine.' },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out);
    assert.equal('locationCheck' in payload.details, false);
  });

  it('a legacy job with no stored request.hunks gives locationCheck: null and the unavailable line', async () => {
    const id = '323456abcdef';
    await upsertJob(tempDir, { id, kind: 'review', status: 'completed' });
    await writeJobFile(tempDir, id, {
      id, kind: 'review', status: 'completed',
      request: { scope: 'working-tree' },
      result: { rawOutput: 'src/app.py:2 is fine.' },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--check-locations', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out);
    assert.equal(payload.details.locationCheck, null);
    assert.ok(
      cap.err.some((line) => line.includes('antigravity:result — location check unavailable: this job predates hunk storage.')),
      cap.err.join(''),
    );

    const text = fs.readFileSync(resolveJobFile(tempDir, id), 'utf8');
    assert.equal(JSON.parse(text).request.hunks, undefined);
  });
});
