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

function resultLine(response, extra = {}) {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-e2e',
      status: 'SUCCESS',
      response,
      duration_seconds: 1.2,
      num_turns: 1,
      usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
      ...extra,
    },
  });
}

// Verbatim shape from the t0a fixture (agy 1.1.27, plan 085): the JSON list
// and the unchanged stderr sentinel arrive together on a real denied run.
const READ_URL_MEMBER = { action: 'read_url', display_name: 'ReadUrlContent' };
const DENIAL_LINE_READ_URL =
  'jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied.';

// Plan 086 T1: agy's print-timeout truncation marker (verbatim from
// t0d-stream-json-print-timeout.txt).
const PRINT_TIMEOUT_LINE =
  '[agy] print timeout after 25s with turn in progress; returning partial output';

// Plan 086 T3: the step_update line (verbatim from
// t0e-denied-read-url-step.txt) that names the denied target, and agy's
// full stderr sentinel including its own bypass advice (verbatim from
// t0-plugin-task-denied-url.txt) — item 4 checks the plugin drops just that
// one sentence from what it prints.
const T0E_STEP_LINE = '{"event":"step_update","step_update":{"conversation_id":"594b90eb-80e4-4271-8563-da2453f36f62","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"read_url_content","duration_seconds":0.127872,"tool_info":{"name":"read_url_content","parameters":{"Url":"https://example.com/"},"error":{"type":"TOOL_ERROR","message":"permission check failed for read_url \\"example.com\\": user denied permission for read_url(example.com)"}}}}';
const DENIAL_LINE_READ_URL_WITH_BYPASS =
  'jetski: no output produced — a tool required the "read_url" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_url(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

let stubDir;
let starvedAgy;
let answeredAgy;
let starvedStructuredAgy;
let answeredStructuredAgy;
let printTimeoutAnsweredAgy;
let printTimeoutEmptyAgy;
let starvedWithTargetAgy;
let answeredWithTargetAgy;

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
  // Plan 085 T2: the structured JSON list travels alongside the stderr
  // sentinel, matching the t0a fixture exactly.
  starvedStructuredAgy = writeFakeAgy(stubDir, 'agy-starved-structured', {
    stdout: resultLine('', { denied_actions: [READ_URL_MEMBER] }) + '\n',
    stderr: DENIAL_LINE_READ_URL + '\n',
  });
  answeredStructuredAgy = writeFakeAgy(stubDir, 'agy-answered-structured', {
    stdout: resultLine('Answer without the URL.', { denied_actions: [READ_URL_MEMBER] }) + '\n',
    stderr: DENIAL_LINE_READ_URL + '\n',
  });
  // Plan 086 T1: the fake agy writes the print-timeout marker to stderr and
  // a partial answer to stdout (non-empty), or an empty response (starved).
  printTimeoutAnsweredAgy = writeFakeAgy(stubDir, 'agy-print-timeout-answered', {
    stdout: resultLine('The Architecture of the Visible Voice: partial essay text') + '\n',
    stderr: PRINT_TIMEOUT_LINE + '\n',
  });
  printTimeoutEmptyAgy = writeFakeAgy(stubDir, 'agy-print-timeout-empty', {
    stdout: resultLine('') + '\n',
    stderr: PRINT_TIMEOUT_LINE + '\n',
  });
  // Plan 086 T3: the step_update line carries the denied target; the
  // stderr sentinel carries agy's own bypass advice the plugin must not
  // repeat on its own stderr.
  starvedWithTargetAgy = writeFakeAgy(stubDir, 'agy-starved-with-target', {
    stdout: [T0E_STEP_LINE, resultLine('', { denied_actions: [READ_URL_MEMBER] })].join('\n') + '\n',
    stderr: DENIAL_LINE_READ_URL_WITH_BYPASS + '\n',
  });
  answeredWithTargetAgy = writeFakeAgy(stubDir, 'agy-answered-with-target', {
    stdout: [T0E_STEP_LINE, resultLine('Answer without the URL.', { denied_actions: [READ_URL_MEMBER] })].join('\n') + '\n',
    stderr: DENIAL_LINE_READ_URL_WITH_BYPASS + '\n',
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

// Plan 085 T2: end-to-end coverage for agy 1.1.27's structured denied_actions
// list, verbatim-shaped like the t0a fixture (both the JSON list and the
// unchanged stderr sentinel present together).
const DENIED_READ_URL = /auto-denied[\s\S]*"read_url"|"read_url"[\s\S]*auto-denied/;

describe('structured denial (agy 1.1.27 denied_actions) — starved run', () => {
  it('task --foreground: exit 1, names read_url, and the remedy line for a non-grantable action', () => {
    const res = runVerb(starvedStructuredAgy, ['task', 'read a url', '--foreground']);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, DENIED_READ_URL);
    assert.match(res.stderr, /cannot grant "read_url"/);
    assert.doesNotMatch(res.stderr, /--add-dir/);
    assert.equal(res.stdout, '');
  });
});

describe('structured denial (agy 1.1.27 denied_actions) — answered run', () => {
  it('task --foreground --json: details.deniedActions carries the remedy, count 1', () => {
    const res = runVerb(answeredStructuredAgy, ['task', 'summarize', '--foreground', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'completed');
    assert.deepEqual(payload.details.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', target: null, remedy: 'Headless runs cannot grant "read_url"; the host must run this step itself.' },
    ]);
  });

  it('rescue: the remedy is also echoed to stderr beside agy\'s own denial line', () => {
    const res = runVerb(answeredStructuredAgy, ['rescue', 'summarize']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, DENIED_READ_URL);
    assert.match(res.stderr, /denied "read_url"/);
    assert.match(res.stderr, /cannot grant "read_url"/);
  });
});

// Plan 086 T1: end-to-end coverage for agy's print-timeout truncation
// marker (>= 1.1.28), verbatim-shaped like t0d-stream-json-print-timeout.txt
// (the marker on stderr, a `result` event on stdout).
const PRINT_TIMEOUT_MARKER = /\[agy\] print timeout after 25s[\s\S]*returning partial output/;

describe('agy print-timeout marker — non-empty answer (plan 086 T1)', () => {
  it('task --foreground --json: exit 0, details.agyPrintTimeout carries the limit, a partial answer is still an answer', () => {
    const res = runVerb(printTimeoutAnsweredAgy, ['task', 'write an essay', '--foreground', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'completed');
    assert.match(payload.answer, /partial essay text/);
    assert.deepEqual(payload.details.agyPrintTimeout, { limit: '25s' });
    assert.match(res.stderr, /print timeout expired \(25s\)/);
  });

  it('rescue: the print-timeout warning is echoed to stderr on a completed run', () => {
    const res = runVerb(printTimeoutAnsweredAgy, ['rescue', 'summarize']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /antigravity:rescue — warning: agy's print timeout expired \(25s\)/);
  });
});

describe('agy print-timeout marker — empty answer fails like a starved denial (plan 086 T1)', () => {
  it('task --foreground: exit 1, names the print timeout as the reason', () => {
    const res = runVerb(printTimeoutEmptyAgy, ['task', 'write an essay', '--foreground']);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, PRINT_TIMEOUT_MARKER);
    assert.match(res.stderr, /print timeout expired \(25s\) before producing any output/);
    assert.equal(res.stdout, '');
  });
});

// Plan 086 T3: end to end, the denied target flows into every output path,
// and the plugin's console output never repeats agy's own bypass advice
// (item 4) even though it is present in what agy actually printed.
describe('denied-action target end to end, and bypass-advice filtering (plan 086 T3)', () => {
  it('starved run, task --foreground: stderr names the target and drops the bypass sentence', () => {
    const res = runVerb(starvedWithTargetAgy, ['task', 'read a url', '--foreground']);
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /read_url \(ReadUrlContent\) for "example\.com"/);
    assert.match(res.stderr, /Add an allow-rule under permissions\.allow/);
    assert.doesNotMatch(res.stderr, /--dangerously-skip-permissions/);
  });

  it('answered run, task --foreground --json: details.deniedActions carries the target', () => {
    const res = runVerb(answeredWithTargetAgy, ['task', 'summarize', '--foreground', '--json']);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.deepEqual(payload.details.deniedActions, [
      {
        action: 'read_url', displayName: 'ReadUrlContent', target: 'example.com',
        remedy: 'Headless runs cannot grant "read_url"; the host must run this step itself.',
      },
    ]);
  });

  it('answered run, rescue: the stderr hint names the target and the bypass sentence is absent', () => {
    const res = runVerb(answeredWithTargetAgy, ['rescue', 'summarize']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /denied read_url \(ReadUrlContent\) for "example\.com"/);
    assert.doesNotMatch(res.stderr, /--dangerously-skip-permissions/);
  });

  it('result --json after a background run: the stored result still has the full upstream line', () => {
    // Background start, wait, and result must share one workspace/data
    // directory pair, unlike runVerb's per-call fresh dirs, so this uses its
    // own env across the three sequential calls.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-denial-bg-work-'));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-denial-bg-data-'));
    const env = {
      ...process.env,
      AGY_BIN: starvedWithTargetAgy,
      CLAUDE_PLUGIN_DATA: data,
      ANTIGRAVITY_PLUGIN_SESSION_ID: 'denial-e2e-bg-' + randomBytes(3).toString('hex'),
    };
    try {
      const start = spawnSync(process.execPath, [BIN, 'task', 'read a url', '--json'], { cwd: work, encoding: 'utf8', env });
      assert.equal(start.status, 0, start.stderr);
      const jobId = JSON.parse(start.stdout).jobId;
      const statusRes = spawnSync(process.execPath, [BIN, 'status', jobId, '--wait', '--json'], { cwd: work, encoding: 'utf8', env });
      assert.equal(statusRes.status, 0, statusRes.stderr);
      const resultRes = spawnSync(process.execPath, [BIN, 'result', jobId, '--json'], { cwd: work, encoding: 'utf8', env });
      const payload = JSON.parse(resultRes.stdout);
      assert.match(payload.details.result.stderr, /--dangerously-skip-permissions/);
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
    }
  });
});
