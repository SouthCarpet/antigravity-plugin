/**
 * Integration coverage for `rememberAgyVersion` (scripts/lib/job-helpers.mjs,
 * Senate R2, 2026-09): `review`, `rescue`, `task`, and `vision` write
 * `agyVersionSeen` to the workspace's state config right after their own
 * successful agy-version probe, before the run itself, so it lands even
 * when the run afterward fails. `review --preview` never does, because
 * it returns before probing agy at all.
 *
 * Runs `bin/antigravity.mjs <verb>` in a real child process against a fake
 * `agy` that passes the `--version` probe but fails the run itself
 * (`writeFakeAgy`'s `echoArgsStderr` + `exitCode: 1`, the same fake
 * `tests/passthrough-argv.test.mjs` uses). No mocks, the real spawn path.
 * The failing run keeps each test to one child process and confirms the
 * cache write happens on the probe, not on a completed job.
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
import { getConfig } from '../scripts/lib/state.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let stubDir;
let echoAgy;
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-agyver-stub-'));
  // versionOk answers `--version` with `0.0.0-fake`; echoArgsStderr + exit 1
  // fails only the run, after the probe already succeeded.
  echoAgy = writeFakeAgy(stubDir, 'agy-echo', { echoArgsStderr: true, exitCode: 1, versionOk: true });
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
    ANTIGRAVITY_PLUGIN_SESSION_ID: 'agyver-' + randomBytes(3).toString('hex'),
  };
}

function runVerb(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

function freshDirs() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-agyver-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-agyver-data-'));
  cleanup.push(work, data);
  return { work, data };
}

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'ignore', env: GIT_ENV });
}

/** A git repo with one committed file, then modified: a real diff `review` will pick up. */
function gitFixtureWithChange() {
  const { work, data } = freshDirs();
  sh('git init -q -b main', work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  sh('git add a.txt', work);
  sh('git commit -q -m initial', work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
  return { work, data };
}

/** 1x1 transparent PNG, just enough for `vision`'s extension/size checks. */
const TINY_PNG_HEX =
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907724da' +
  '0000000a4944415478da6360000002000155020e2b0100000049454e44ae426082';

/**
 * Read `agyVersionSeen` from `work`'s state config. `getConfig` reads
 * `process.env` internally, so this borrows `CLAUDE_PLUGIN_DATA` for the
 * one synchronous call, matching the child process's own environment, then
 * restores whatever the parent test process had.
 */
function readAgyVersionSeen(work, data) {
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    return getConfig(work).agyVersionSeen;
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev;
  }
}

describe('rememberAgyVersion is wired into review, rescue, task, and vision (Senate R2)', () => {
  it('rescue (foreground, failing run) still caches agyVersionSeen from the earlier probe', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['rescue', 'probe'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    const seen = readAgyVersionSeen(work, data);
    assert.equal(seen.version, '0.0.0-fake');
    assert.ok(seen.observedAt);
  });

  it('task --foreground (failing run) caches agyVersionSeen', () => {
    const { work, data } = freshDirs();
    const res = runVerb(['task', 'probe', '--foreground'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.equal(readAgyVersionSeen(work, data).version, '0.0.0-fake');
  });

  it('vision (failing run) caches agyVersionSeen', () => {
    const { work, data } = freshDirs();
    const imagePath = path.join(work, 'pixel.png');
    fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_HEX, 'hex'));
    const res = runVerb(['vision', imagePath, '--prompt', 'probe'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.equal(readAgyVersionSeen(work, data).version, '0.0.0-fake');
  });

  it('review (foreground, failing run) caches agyVersionSeen', () => {
    const { work, data } = gitFixtureWithChange();
    const res = runVerb(['review'], makeEnv(data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.equal(readAgyVersionSeen(work, data).version, '0.0.0-fake');
  });

  it('review --preview never caches agyVersionSeen: it returns before any agy probe', () => {
    const { work, data } = gitFixtureWithChange();
    const res = runVerb(['review', '--preview'], makeEnv(data), work);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readAgyVersionSeen(work, data), undefined);
  });
});
