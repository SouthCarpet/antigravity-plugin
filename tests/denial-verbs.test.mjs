/**
 * End-to-end: how the verbs surface a headless auto-denial (agy >= 1.1.20).
 *
 * Runs `bin/antigravity.mjs <verb>` in a child process with `AGY_BIN`
 * pointed at a fake agy (tests/helpers/fake-agy.mjs) that emits a SUCCESS
 * result event on stdout and the 1.1.24 denial line on stderr, exit 0.
 * A child process is used on purpose: capturing process.stdout in-process
 * races node:test's reporter as soon as the runtime yields to the event
 * loop, which it must to read the fake's streams.
 *
 * Expected:
 *   - empty response + denial -> exit 1, stderr names the tool and gives
 *     the per-verb hint (`--add-dir <dir>` for rescue/task, `view_image`
 *     for vision, never `--add-dir` for vision);
 *   - non-empty response + denial -> exit 0, `--json` carries the denial
 *     under `details.warnings`, and it also stays on stderr.
 *
 * The fake binary writes stderr through the console code page on Windows,
 * so the em dash in the fixture may not survive byte-for-byte here; these
 * assertions match the stable parts (`auto-denied`, the quoted tool). The
 * exact-line equality lives in tests/agent-runtime-denial.test.mjs.
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

const DENIAL_LINE =
  'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_file(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

function resultLine(response) {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-e2e',
      status: 'SUCCESS',
      response,
      duration_seconds: 1.2,
      num_turns: 1,
      usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
    },
  });
}

let stubDir;
let starvedAgy;
let answeredAgy;

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-denial-e2e-'));
  starvedAgy = writeFakeAgy(stubDir, 'agy-starved', {
    stdout: resultLine('') + '\n',
    stderr: DENIAL_LINE + '\n',
  });
  answeredAgy = writeFakeAgy(stubDir, 'agy-answered', {
    stdout: resultLine('Answer without the file.') + '\n',
    stderr: DENIAL_LINE + '\n',
  });
});

after(() => {
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
});

function runVerb(agyBin, args) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-denial-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-denial-data-'));
  try {
    return {
      work,
      ...spawnSync(process.execPath, [BIN, ...args], {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGY_BIN: agyBin,
          CLAUDE_PLUGIN_DATA: data,
          ANTIGRAVITY_PLUGIN_SESSION_ID: 'denial-e2e-' + randomBytes(3).toString('hex'),
        },
      }),
    };
  } finally {
    setImmediate(() => {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
    });
  }
}

const DENIED_READ_FILE = /auto-denied[\s\S]*"read_file"|"read_file"[\s\S]*auto-denied/;

describe('starved run (empty response + denial) fails with a per-verb hint', () => {
  it('rescue: exit 1, names read_file, hints --add-dir <dir>', () => {
    const res = runVerb(starvedAgy, ['rescue', 'read the notes']);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /antigravity:rescue — failed \(failed\)/);
    assert.match(res.stderr, DENIED_READ_FILE);
    assert.match(res.stderr, /--add-dir <dir>/);
    assert.equal(res.stdout, '');
  });

  it('task --foreground: exit 1, hints --add-dir <dir>', () => {
    const res = runVerb(starvedAgy, ['task', 'read the notes', '--foreground']);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, DENIED_READ_FILE);
    assert.match(res.stderr, /--add-dir <dir>/);
  });

  it('vision: exit 1, hints view_image and never --add-dir', () => {
    const img = path.join(stubDir, 'shot.png');
    fs.writeFileSync(img, 'not-a-real-png');
    const res = runVerb(starvedAgy, ['vision', img, '--prompt', 'what text is visible?']);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, DENIED_READ_FILE);
    assert.match(res.stderr, /view_image/);
    assert.doesNotMatch(res.stderr, /--add-dir/);
    assert.equal(res.stdout, '');
  });
});

describe('answered run (non-empty response + denial) completes with a warning', () => {
  it('rescue --json: exit 0, details.warnings carries the denial, stderr keeps it', () => {
    const res = runVerb(answeredAgy, ['rescue', 'summarize', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'completed');
    assert.equal(payload.answer, 'Answer without the file.');
    assert.equal(payload.details.warnings.length, 1);
    assert.match(payload.details.warnings[0], DENIED_READ_FILE);
    assert.match(res.stderr, DENIED_READ_FILE);
  });

  it('task --foreground --json: same shape', () => {
    const res = runVerb(answeredAgy, ['task', 'summarize', '--foreground', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'completed');
    assert.match(payload.details.warnings[0], DENIED_READ_FILE);
  });

  it('vision --json: warnings ride beside usage in details', () => {
    const img = path.join(stubDir, 'shot2.png');
    fs.writeFileSync(img, 'not-a-real-png');
    const res = runVerb(answeredAgy, ['vision', img, '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.match(payload.details.warnings[0], DENIED_READ_FILE);
    assert.equal(payload.details.usage.total_tokens, 55);
  });

  it('a clean run has no warnings key', () => {
    const clean = writeFakeAgy(stubDir, 'agy-clean', { stdout: resultLine('done') + '\n' });
    const res = runVerb(clean, ['task', 'do it', '--foreground', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(Object.hasOwn(payload.details, 'warnings'), false);
  });
});
