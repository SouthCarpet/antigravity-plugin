/**
 * The real failure reason in JSON errors (3.0.0, "R5").
 *
 * A fake agy ends the run with `result.status: ERROR` and a `result.error`
 * line, with no `error:` marker on stderr (the agy 1.3.1 capacity failure).
 * The reason must reach `details.error.message` in three places: the
 * foreground `--json` envelope, `result <id> --json` after a background run,
 * and the stored job record. It must be one redacted, bounded line in all
 * three, and each path keeps its own error code.
 *
 * Runs `bin/antigravity.mjs` in a child process (real dispatcher, real verb,
 * real spawn); no mocks.
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

const CAPACITY_ERROR =
  'API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.6-flash-high on the server';
const GENERIC_MESSAGE = 'failed (failed).';

/** Each case: the `result.error` agy sends, and the message the envelope must carry. */
const CASES = [
  { name: '503 capacity with no stderr marker', error: CAPACITY_ERROR, expected: CAPACITY_ERROR },
  {
    name: 'a synthetic bearer and refresh token',
    error: 'auth failed: Bearer SYNTHETIC-bearer-0123456789 and refresh_token=SYNTHETIC-refresh-0123456789',
    expected: 'auth failed: Bearer [redacted] and refresh_token=[redacted]',
  },
  {
    name: 'an OAuth callback URL with a query string',
    error: 'refresh failed at https://oauth2.googleapis.com/token?grant_type=refresh_token&code=SYNTHETIC&state=s',
    expected: 'refresh failed at [redacted-url]',
  },
  {
    name: 'multi-line text',
    error: 'UNAVAILABLE\nstack line one\r\n\tstack line two',
    expected: 'UNAVAILABLE stack line one stack line two',
  },
  {
    name: 'over-length text',
    error: 'capacity '.repeat(100),
    expected: 'capacity '.repeat(100).slice(0, 300),
  },
  {
    name: 'a reason that is only a token (generic text stays)',
    error: 'ya29.SYNTHETIC-token-0123456789',
    expected: GENERIC_MESSAGE,
  },
];

let stubDir;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-reason-'));
});

after(() => {
  for (const dir of [stubDir, ...cleanup]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function resultErrorAgy(name, error, extra = {}) {
  const line = JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error } });
  return writeFakeAgy(stubDir, name, { stdout: `${line}\n`, exitCode: 1, versionOk: true, ...extra });
}

function freshDirs() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-reason-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-reason-data-'));
  cleanup.push(work, data);
  return { work, data };
}

function runVerb(args, agy, data, cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGY_BIN: agy,
      CLAUDE_PLUGIN_DATA: data,
      ANTIGRAVITY_PLUGIN_SESSION_ID: 'reason-' + randomBytes(3).toString('hex'),
      ...extraEnv,
    },
  });
}

function readStoredJob(data, jobId) {
  const records = fs.readdirSync(data, { recursive: true }).filter((file) => file.endsWith(`${jobId}.json`));
  assert.equal(records.length, 1);
  return JSON.parse(fs.readFileSync(path.join(data, records[0]), 'utf8'));
}

describe('the safe failure reason reaches every JSON writer', () => {
  CASES.forEach(({ name, error, expected }, index) => {
    const storedExpected = expected === GENERIC_MESSAGE ? null : expected;

    it(`foreground task --json: ${name}`, () => {
      const { work, data } = freshDirs();
      const agy = resultErrorAgy(`agy-fg-${index}`, error);
      const res = runVerb(['task', 'go', '--foreground', '--json'], agy, data, work);
      assert.equal(res.status, 1, res.stderr);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.status, 'failed');
      assert.equal(payload.answer, null);
      assert.equal(payload.details.error.code, 'run_failed');
      assert.equal(payload.details.error.phase, 'run');
      assert.equal(payload.details.error.message, expected);
      const stored = readStoredJob(data, payload.jobId);
      assert.equal(stored.healthMessage ?? null, storedExpected);
      if (storedExpected !== null) assert.equal(stored.errorMessage, storedExpected);
    });

    it(`background task, then result --json: ${name}`, () => {
      const { work, data } = freshDirs();
      const agy = resultErrorAgy(`agy-bg-${index}`, error);
      const queued = runVerb(['task', 'go', '--wait', '--json'], agy, data, work);
      assert.equal(queued.status, 1, queued.stderr);
      const { jobId } = JSON.parse(queued.stdout);
      const stored = runVerb(['result', jobId, '--json'], agy, data, work);
      assert.equal(stored.status, 1, stored.stderr);
      const payload = JSON.parse(stored.stdout);
      assert.equal(payload.status, 'failed');
      assert.equal(payload.details.error.code, 'job_failed');
      assert.equal(payload.details.error.phase, 'run');
      assert.equal(payload.details.error.message, expected === GENERIC_MESSAGE ? `job ${jobId} failed.` : expected);
      const record = readStoredJob(data, jobId);
      assert.equal(record.healthMessage ?? null, storedExpected);
      if (storedExpected !== null) assert.equal(record.errorMessage, storedExpected);
    });
  });

  it('keeps the stderr line and the exit code as they were', () => {
    const { work, data } = freshDirs();
    const agy = resultErrorAgy('agy-stderr', CAPACITY_ERROR);
    const res = runVerb(['task', 'go', '--foreground', '--json'], agy, data, work);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^\nantigravity:task — failed \(failed\)\.$/m);
    assert.match(res.stderr, /agent-runtime: agy reported error: API error \(attempt 1\)/);
  });

  it('a sign-in URL in result.error is an auth_required envelope with no URL in its message', () => {
    const { work, data } = freshDirs();
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&state=s';
    const agy = resultErrorAgy('agy-signin', `sign in at ${url}`);
    const res = runVerb(['task', 'go', '--foreground', '--json'], agy, data, work);
    assert.equal(res.status, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.details.error.code, 'auth_required');
    assert.equal(payload.details.error.message, 'Antigravity is not authenticated.');
  });

  it('a timeout keeps its own code and message, whatever result.error said', () => {
    const { work, data } = freshDirs();
    const agy = resultErrorAgy('agy-timeout', CAPACITY_ERROR, { exitCode: 0, delayMs: 20000 });
    const res = runVerb(['task', 'go', '--foreground', '--json'], agy, data, work, {
      ANTIGRAVITY_AGY_TIMEOUT_MS: '1500',
    });
    assert.equal(res.status, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'timeout');
    assert.equal(payload.details.error.code, 'timeout');
    assert.equal(payload.details.error.message, 'failed (timeout).');
    const stored = readStoredJob(data, payload.jobId);
    assert.equal(stored.errorMessage, 'agy did not finish within 1500 ms');
    assert.equal(stored.healthMessage, 'agy did not finish within 1500 ms');
  });
});
