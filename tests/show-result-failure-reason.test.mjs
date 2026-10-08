/**
 * `--show-result` filters upstream stderr used as a failure reason.
 *
 * A fake agy exits 1 with only stderr text: no `result.error`, no `error:`
 * marker. The plugin then has no reason from agy's own channels, and the
 * stored `errorMessage` used to fall back to the raw stderr. The
 * `--show-result` envelope reads that field first. The allow-list keeps short
 * token-shaped strings but replaces disallowed tokens, URLs and Basic auth.
 *
 * Runs `bin/antigravity.mjs` in a child process for all three verbs that
 * accept `--show-result` (`review`, `rescue`, `task`); no mocks.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { writeFakeAgy } from './helpers/fake-agy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
};

const TOKEN = 'ya29.SYNTHETIC-token-0123456789';
const URL_SECRET = 'SYNTHETIC-oauth-code-987';
const OAUTH_STDERR =
  `refresh failed at https://oauth2.googleapis.com/token?grant_type=refresh_token&code=${URL_SECRET}&state=s`;

/** Each case: what agy wrote on stderr, the message the output must carry ({id} is the job id), and the secret. */
const CASES = [
  { name: 'a token-shaped string that fits the grammar', stderr: TOKEN, message: TOKEN, secret: null, stored: TOKEN },
  {
    name: 'a disallowed token and nothing else',
    stderr: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    message: 'job {id} failed.',
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    stored: null,
  },
  {
    name: 'a Basic-auth header is redacted',
    stderr: 'request failed: Authorization: Basic dXNlcjpwYXNz',
    message: 'request failed: Authorization: [redacted]',
    secret: 'dXNlcjpwYXNz',
    stored: 'request failed: Authorization: [redacted]',
  },
  {
    name: 'an OAuth URL with a query string',
    stderr: OAUTH_STDERR,
    message: 'refresh failed at [redacted-url]',
    secret: URL_SECRET,
    stored: 'refresh failed at [redacted-url]',
  },
];

const VERBS = [
  { kind: 'review', args: ['review', '--background', '--wait', '--show-result'] },
  { kind: 'rescue', args: ['rescue', 'go', '--background', '--wait', '--show-result'] },
  { kind: 'task', args: ['task', 'go', '--wait', '--show-result'] },
];

let stubDir;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-showres-'));
});

after(() => {
  for (const dir of [stubDir, ...cleanup]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function freshRepo() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-showres-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-showres-data-'));
  cleanup.push(work, data);
  execSync('git init -q', { cwd: work, stdio: 'ignore', env: GIT_ENV });
  execSync('git commit --allow-empty -q -m init', { cwd: work, stdio: 'ignore', env: GIT_ENV });
  fs.writeFileSync(path.join(work, 'brand-new.txt'), 'never committed\n');
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
      ANTIGRAVITY_PLUGIN_SESSION_ID: 'showres-' + randomBytes(3).toString('hex'),
    },
  });
}

function readStoredJob(data, jobId) {
  const records = fs.readdirSync(data, { recursive: true }).filter((file) => file.endsWith(`${jobId}.json`));
  assert.equal(records.length, 1);
  return JSON.parse(fs.readFileSync(path.join(data, records[0]), 'utf8'));
}

function failingAgy(name, stderr) {
  // Wait for the prompt's EOF so early exit cannot add an EPIPE error.
  return writeFakeAgy(stubDir, name, { stderr, exitCode: 1, versionOk: true, readStdin: true });
}

describe('--show-result renders only the redacted reason for a stderr-only failure', () => {
  VERBS.forEach(({ kind, args }) => {
    CASES.forEach(({ name, stderr, message, secret, stored }, index) => {
      it(`${kind} --json: ${name}`, () => {
        const { work, data } = freshRepo();
        const agy = failingAgy(`agy-json-${kind}-${index}`, stderr);
        const res = runVerb([...args, '--json'], agy, data, work);
        assert.equal(res.status, 1, res.stderr);
        const payload = JSON.parse(res.stdout);
        assert.equal(payload.status, 'failed');
        assert.equal(payload.details.error.code, 'job_failed');
        assert.equal(payload.details.error.message, message.replace('{id}', payload.jobId));
        if (secret !== null) assert.equal(res.stdout.includes(secret), false, 'secret reached stdout');
        assert.equal(readStoredJob(data, payload.jobId).errorMessage, stored);
      });

      it(`${kind} text: ${name}`, () => {
        const { work, data } = freshRepo();
        const agy = failingAgy(`agy-text-${kind}-${index}`, stderr);
        const res = runVerb(args, agy, data, work);
        assert.equal(res.status, 1, res.stderr);
        const jobId = readJobIdFromData(data);
        assert.ok(res.stderr.split(/\r?\n/).includes(`antigravity:${kind} — ${message.replace('{id}', jobId)}`), res.stderr);
        if (secret !== null) {
          assert.equal(res.stdout.includes(secret), false, 'secret reached stdout');
          assert.equal(res.stderr.includes(secret), false, 'secret reached stderr');
        }
      });
    });
  });
});

function readJobIdFromData(data) {
  const files = fs.readdirSync(data, { recursive: true }).filter((file) => /[\\/]jobs[\\/][^\\/]+\.json$/.test(file));
  assert.equal(files.length, 1);
  return path.basename(files[0], '.json');
}

describe('status and result render the filtered stored reason', () => {
  CASES.forEach(({ name, stderr, secret, stored }, index) => {
    it(`task, then status <id> and result <id>: ${name}`, () => {
      const { work, data } = freshRepo();
      const agy = failingAgy(`agy-read-${index}`, stderr);
      const queued = runVerb(['task', 'go', '--wait', '--json'], agy, data, work);
      assert.equal(queued.status, 1, queued.stderr);
      const { jobId } = JSON.parse(queued.stdout);

      const status = runVerb(['status', jobId], agy, data, work);
      if (secret !== null) assert.equal(status.stdout.includes(secret), false, 'secret reached status stdout');
      if (stored === null) assert.equal(status.stdout.includes('## Error'), false);
      else assert.match(status.stdout, new RegExp(`^## Error\\r?\\n\\r?\\n${escapeRegExp(stored)}$`, 'm'));

      const result = runVerb(['result', jobId], agy, data, work);
      if (secret !== null) assert.equal(result.stdout.includes(secret), false, 'secret reached result stdout');
      const json = runVerb(['result', jobId, '--json'], agy, data, work);
      // The stored `result.stderr` stays unredacted and is outside the promise
      // (docs/COMPATIBILITY.md, "Failure reason"); the error message is not.
      // `result --json` reads `healthMessage` only, which a stderr-only failure leaves unset.
      const message = JSON.parse(json.stdout).details.error.message;
      assert.equal(message, `job ${jobId} failed.`);
    });
  });
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
