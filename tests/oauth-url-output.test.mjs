/**
 * No Google OAuth URL leaves the plugin: not on stderr from `result.error`,
 * not in progress text, not in a stored `rawOutput` or answer, and not when
 * `result`, `status` or a background wait print a record that an older
 * version stored with one. Other URLs and plain mentions of the host stay.
 *
 * The CLI cases run `bin/antigravity.mjs` in a child process with a fake agy
 * (real dispatcher, real verb, real spawn). Every input is synthetic.
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
import { captureStdio } from './helpers/capture-stdio.mjs';
import {
  OAUTH_URL_MARKER, createOAuthUrlFilter, removeOAuthUrls, removeOAuthUrlsDeep,
} from '../scripts/lib/safe-reason.mjs';
import { waitAndReport } from '../scripts/lib/job-helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');

const URL = 'https://accounts.google.com/o/oauth2/auth?client_id=attacker&redirect_uri=https%3A%2F%2Fevil.test';
const SIGNIN_URL = 'Https://accounts.google.com/signin/oauth/consent?authuser=0&client_id=attacker';
const OTHER_URL = 'https://example.test/docs';
const HOST_MENTION = 'Sign-in happens at accounts.google.com in your browser.';

let stubDir;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-'));
});

after(() => {
  for (const dir of [stubDir, ...cleanup]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function freshDirs() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-data-'));
  cleanup.push(work, data);
  return { work, data };
}

function runVerb(args, agy, data, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGY_BIN: agy,
      CLAUDE_PLUGIN_DATA: data,
      ANTIGRAVITY_PLUGIN_SESSION_ID: 'oauth-' + randomBytes(3).toString('hex'),
    },
  });
}

/** The path of one stored file under the data root whose name ends with `suffix`. */
function storedFile(data, suffix) {
  const files = fs.readdirSync(data, { recursive: true }).filter((file) => file.endsWith(suffix));
  assert.equal(files.length, 1, `one ${suffix} under ${data}`);
  return path.join(data, files[0]);
}

function event(value) {
  return `${JSON.stringify(value)}\n`;
}

function successAgy(name, response, before = '') {
  return writeFakeAgy(stubDir, name, {
    stdout: `${before}${event({ event: 'result', result: { status: 'SUCCESS', response } })}`,
    versionOk: true,
  });
}

/** Absence of the URL string itself (and of its host+path) in all output. */
function assertNoOAuthUrl(res, label) {
  for (const stream of ['stdout', 'stderr']) {
    assert.equal(res[stream].includes('accounts.google.com/o/oauth2'), false, `${label} ${stream}: ${res[stream]}`);
    assert.equal(res[stream].toLowerCase().includes('accounts.google.com/signin/oauth'), false, `${label} ${stream}: ${res[stream]}`);
  }
}

describe('removeOAuthUrls', () => {
  it('removes both Google OAuth URL forms, with any scheme case and with or without a query', () => {
    assert.equal(removeOAuthUrls(`sign in at ${URL} now`), `sign in at ${OAUTH_URL_MARKER} now`);
    assert.equal(removeOAuthUrls(SIGNIN_URL), OAUTH_URL_MARKER);
    assert.equal(removeOAuthUrls('HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth'), OAUTH_URL_MARKER);
    assert.equal(removeOAuthUrls('see accounts.google.com/o/oauth2/auth.'), `see ${OAUTH_URL_MARKER}`);
    assert.equal(removeOAuthUrls('x https://u@accounts.google.com:443/o/oauth2/auth?a=1 "y"'), `x ${OAUTH_URL_MARKER} "y"`);
    assert.equal(removeOAuthUrls(`${URL}\n${URL}`), `${OAUTH_URL_MARKER}\n${OAUTH_URL_MARKER}`);
  });

  it('keeps other URLs and a plain mention of the host', () => {
    for (const text of [OTHER_URL, HOST_MENTION, 'https://accounts.google.com/', 'https://oauth2.googleapis.com/token']) {
      assert.equal(removeOAuthUrls(text), text);
    }
  });

  it('removeOAuthUrlsDeep covers strings in nested objects and arrays, and keeps other values', () => {
    const err = new Error('kept');
    assert.deepEqual(removeOAuthUrlsDeep({ a: [URL, 1, null], b: { c: `x ${URL}` }, e: err, n: 2 }), {
      a: [OAUTH_URL_MARKER, 1, null], b: { c: `x ${OAUTH_URL_MARKER}` }, e: err, n: 2,
    });
  });

  it('the stream filter removes a URL split across chunks and writes all other text', () => {
    const out = [];
    const filter = createOAuthUrlFilter((text) => out.push(text));
    for (const chunk of ['Open https://accounts.goo', 'gle.com/o/oauth2/auth?client_id=x', ' now. Also ', OTHER_URL]) {
      filter.write(chunk);
    }
    filter.flush();
    assert.equal(out.join(''), `Open ${OAUTH_URL_MARKER} now. Also ${OTHER_URL}`);
  });
});

describe('agy text from a new run', () => {
  it('result.error with an OAuth URL: stderr and stdout have no URL, the rest of the line stays', () => {
    const { work, data } = freshDirs();
    const line = event({ event: 'result', result: { status: 'ERROR', response: '', error: `sign in at ${URL} please` } });
    const agy = writeFakeAgy(stubDir, 'agy-result-error', { stdout: line, exitCode: 1, versionOk: true });
    for (const args of [['task', 'go', '--foreground'], ['task', 'go', '--foreground', '--json']]) {
      const res = runVerb(args, agy, data, work);
      assert.equal(res.status, 1, res.stderr);
      assertNoOAuthUrl(res, args.join(' '));
      assert.match(res.stderr, /agent-runtime: agy reported error: sign in at \[oauth-url-removed\] please/);
    }
  });

  it('raw auth lines before the first event: stored rawOutput, answer and result --json have no URL', () => {
    const { work, data } = freshDirs();
    const prompt = [
      'Authentication required. Please visit the URL to log in:',
      `  ${URL}`,
      'Waiting for authentication (timeout 30s)...',
      '',
    ].join('\n');
    const agy = writeFakeAgy(stubDir, 'agy-raw-auth', { stdout: prompt, exitCode: 1, versionOk: true });

    const queued = runVerb(['task', 'probe', '--wait', '--json'], agy, data, work);
    assertNoOAuthUrl(queued, 'task --wait');
    const { jobId } = JSON.parse(queued.stdout);
    const stored = fs.readFileSync(storedFile(data, `${jobId}.json`), 'utf8');
    assert.equal(stored.includes('accounts.google.com/o/oauth2'), false, stored);
    assert.ok(JSON.parse(stored).result.rawOutput.includes(OAUTH_URL_MARKER), 'the stored answer keeps the marker');

    const shown = runVerb(['result', jobId, '--json'], agy, data, work);
    assertNoOAuthUrl(shown, 'result --json');
    const payload = JSON.parse(shown.stdout);
    assert.match(payload.answer, /Please visit the URL to log in:\s+\[oauth-url-removed\]/);
    assert.equal(payload.details.result.rawOutput, payload.answer);

    const fg = runVerb(['task', 'probe', '--foreground'], agy, data, work);
    assertNoOAuthUrl(fg, 'task --foreground');
    assert.match(fg.stderr, /^Run \/antigravity:setup to complete the OAuth flow, then retry\.$/m);
  });

  it('progress text: a URL split across two text deltas is not printed', () => {
    const { work, data } = freshDirs();
    const stdout = [
      event({ event: 'step_update', step_update: { step_type: 'text', text_delta: 'Open https://accounts.goo' } }),
      event({ event: 'step_update', step_update: { step_type: 'text', text_delta: 'gle.com/o/oauth2/auth?client_id=attacker now.\n' } }),
      event({ event: 'result', result: { status: 'SUCCESS', response: 'done' } }),
    ].join('');
    const agy = writeFakeAgy(stubDir, 'agy-progress', { stdout, versionOk: true });
    const res = runVerb(['rescue', 'do it'], agy, data, work);
    assert.equal(res.status, 0, res.stderr);
    assertNoOAuthUrl(res, 'rescue');
    assert.match(res.stderr, /Open \[oauth-url-removed\] now\./);
  });

  it('an answer with another URL and a plain host mention keeps both (false-positive case)', () => {
    const { work, data } = freshDirs();
    const answer = `Read ${OTHER_URL}. ${HOST_MENTION}`;
    const agy = successAgy('agy-fp', answer);
    const res = runVerb(['task', 'go', '--foreground', '--json'], agy, data, work);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.answer, answer);
    const shown = runVerb(['result', payload.jobId, '--json'], agy, data, work);
    assert.equal(JSON.parse(shown.stdout).answer, `${answer}\n`);
  });
});

describe('a record stored with a URL by an older version', () => {
  const ANSWER = 'plain answer';

  /** Run one completed job, then put the URL into its stored text, as 3.0.0 could. */
  function plantLegacyJob(name) {
    const { work, data } = freshDirs();
    const agy = successAgy(name, ANSWER);
    const res = runVerb(['task', 'go', '--foreground', '--json'], agy, data, work);
    assert.equal(res.status, 0, res.stderr);
    const { jobId } = JSON.parse(res.stdout);
    for (const file of [storedFile(data, `${jobId}.json`), storedFile(data, 'state.json')]) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.includes(ANSWER), `${file} holds the answer or summary`);
      fs.writeFileSync(file, text.replaceAll(ANSWER, `${ANSWER} ${URL}`));
    }
    const record = JSON.parse(fs.readFileSync(storedFile(data, `${jobId}.json`), 'utf8'));
    record.result.stderr = `agy said: ${SIGNIN_URL}`;
    fs.writeFileSync(storedFile(data, `${jobId}.json`), JSON.stringify(record));
    fs.appendFileSync(storedFile(data, `${jobId}.log`), `progress ${URL}\n`);
    return { work, data, agy, jobId };
  }

  it('result --json and result print no URL in answer or details.result', () => {
    const { work, data, agy, jobId } = plantLegacyJob('agy-legacy-result');
    const json = runVerb(['result', jobId, '--json'], agy, data, work);
    assert.equal(json.status, 0, json.stderr);
    assertNoOAuthUrl(json, 'result --json');
    const payload = JSON.parse(json.stdout);
    assert.equal(payload.answer, `${ANSWER} ${OAUTH_URL_MARKER}\n`);
    assert.equal(payload.details.result.rawOutput, `${ANSWER} ${OAUTH_URL_MARKER}`);
    assert.equal(payload.details.result.stderr, `agy said: ${OAUTH_URL_MARKER}`);
    assertNoOAuthUrl(runVerb(['result', jobId], agy, data, work), 'result');
  });

  it('status --json and status print no URL in the summary or the log lines', () => {
    const { work, data, agy, jobId } = plantLegacyJob('agy-legacy-status');
    const json = runVerb(['status', jobId, '--json'], agy, data, work);
    assertNoOAuthUrl(json, 'status --json');
    assert.ok(json.stdout.includes(OAUTH_URL_MARKER), json.stdout);
    assertNoOAuthUrl(runVerb(['status', jobId], agy, data, work), 'status');
    assertNoOAuthUrl(runVerb(['status', '--json'], agy, data, work), 'status list');
  });
});

describe('a background wait prints a stored record without a URL', () => {
  async function report(final, options) {
    const cap = captureStdio();
    let exit;
    try {
      exit = await waitAndReport('task', '/unused', 'abcdefabcdef', async () => final, options);
    } finally {
      cap.restore();
    }
    return { exit, out: cap.out.join(''), err: cap.err.join('') };
  }

  it('task --wait prints a completed answer without the URL', async () => {
    const { exit, out } = await report(
      { id: 'abcdefabcdef', kind: 'task', status: 'completed', result: { rawOutput: `answer ${URL}\n` } },
      { json: false },
    );
    assert.equal(exit, 0);
    assert.equal(out, `answer ${OAUTH_URL_MARKER}\n`);
  });

  it('--show-result prints a failed job\'s stored reason without the URL', async () => {
    const { exit, err } = await report(
      { id: 'abcdefabcdef', kind: 'task', status: 'failed', errorMessage: `sign in at ${URL}` },
      { showResult: true },
    );
    assert.equal(exit, 1);
    assert.equal(err, `antigravity:task — sign in at ${OAUTH_URL_MARKER}\n`);
  });
});
