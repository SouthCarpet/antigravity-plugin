/**
 * Headless permission denials on agy >= 1.1.20.
 *
 * Since 1.1.20 a tool that headless mode cannot prompt for is auto-denied
 * and the run still exits 0 with `status: SUCCESS`. The only trace is a
 * stderr line; the `response` is empty when the denial starved the answer,
 * or non-empty when the model answered anyway with one input missing.
 * Probed live on 1.1.24 (plan 068, 2026-09-02).
 *
 * Rules under test:
 *   (a) SUCCESS + empty/whitespace response + denial line  -> failed
 *   (b) SUCCESS + non-empty response + denial line          -> completed,
 *       denial kept in stderr AND surfaced as a warning
 *   SUCCESS + empty response + NO denial line               -> completed
 *   result status CANCELED (pre-1.1.20 shape)               -> failed (unchanged)
 *
 * Same owned process-adapter spawn fake as tests/agent-runtime-stream.test.mjs,
 * installed before agent-runtime.mjs (and the verbs that import it) load.
 * Never spawns the real `agy`.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Verbatim from agy 1.1.24 stderr (plan 068 probe A). Only `auto-denied`
// and the quoted tool name are treated as stable; agy rewords the hints.
const DENIAL_LINE =
  'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_file(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

const spawnCalls = [];
let nextStdout = [];
let nextStderr = [];
let nextExitCode = 0;

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => true;
  child.stdin = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  return child;
}

mock.module('../scripts/lib/process-adapter.mjs', {
  namedExports: {
    spawn: (bin, args, opts) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, opts, child });
      setImmediate(() => {
        for (const chunk of nextStderr) child.stderr.emit('data', chunk);
        for (const chunk of nextStdout) child.stdout.emit('data', chunk);
        child.emit('exit', nextExitCode);
        child.emit('close', nextExitCode);
      });
      return child;
    },
  },
});

const {
  runAgyPrint, detectAutoDenial, parseAgyStream,
  normalizeDeniedActions, mergeDeniedActions,
  MAX_DENIED_ACTIONS, MAX_DENIED_ACTION_STRING_LENGTH,
} = await import('../scripts/lib/agent-runtime.mjs');

function resultLine(overrides = {}) {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-den',
      status: 'SUCCESS',
      response: '',
      duration_seconds: 2.1,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
      ...overrides,
    },
  });
}

function arm({ response = '', status = 'SUCCESS', stderr = '', error, exitCode = 0, deniedActions } = {}) {
  spawnCalls.length = 0;
  const overrides = { response, status };
  if (error !== undefined) overrides.error = error;
  if (deniedActions !== undefined) overrides.denied_actions = deniedActions;
  nextStdout = [resultLine(overrides) + '\n'];
  nextStderr = stderr ? [stderr + '\n'] : [];
  nextExitCode = exitCode;
}

describe('detectAutoDenial', () => {
  it('finds the tool name from the quoted part of an auto-denied line', () => {
    const hit = detectAutoDenial(`noise before\n${DENIAL_LINE}\nnoise after\n`);
    assert.equal(hit.tool, 'read_file');
    assert.equal(hit.line, DENIAL_LINE);
  });

  it('matches on the stable parts only, not the full sentence', () => {
    const reworded = 'jetski: "view_image" was auto-denied (no prompt in headless mode)';
    assert.equal(detectAutoDenial(reworded).tool, 'view_image');
  });

  it('returns null when nothing was auto-denied', () => {
    assert.equal(detectAutoDenial('CLI settings initialized: permissions=...\n'), null);
    assert.equal(detectAutoDenial(''), null);
    assert.equal(detectAutoDenial(undefined), null);
  });
});

describe('runAgyPrint — auto-denial classification', () => {
  it('(a) SUCCESS + empty response + denial line -> failed, error names the tool', async () => {
    arm({ response: '', stderr: DENIAL_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.equal(res.stdout, '');
    assert.deepEqual(res.warnings, []);
    assert.equal(res.denial.tool, 'read_file');
    assert.match(res.stderr, /agent-runtime: .*"read_file".*headless/);
    assert.match(res.stderr, /auto-denied/);
  });

  it('(a) a whitespace-only response counts as empty', async () => {
    arm({ response: ' \n\t ', stderr: DENIAL_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
  });

  it('(b) SUCCESS + non-empty response + denial line -> completed with the denial as a warning', async () => {
    arm({ response: 'The visible text is ZETA-4471.', stderr: DENIAL_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'The visible text is ZETA-4471.');
    assert.deepEqual(res.warnings, [DENIAL_LINE]);
    assert.ok(res.stderr.includes(DENIAL_LINE), 'the denial line stays in stderr');
    assert.equal(res.denial.tool, 'read_file');
  });

  it('SUCCESS + empty response + NO denial line stays completed', async () => {
    // A model may legitimately say nothing (for example when asked to
    // stay silent). Without a denial on stderr there is no evidence of a
    // starved run, so this is not reclassified.
    arm({ response: '', stderr: 'CLI settings initialized: permissions=&{Allow:[]}' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, '');
    assert.deepEqual(res.warnings, []);
    assert.equal(res.denial, null);
  });

  it('keeps the CANCELED path for older agy: non-SUCCESS result is failed', async () => {
    arm({ response: '', status: 'CANCELED', stderr: DENIAL_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.match(res.stderr, /"CANCELED", not SUCCESS/);
  });

  it('a normal SUCCESS with no stderr carries an empty warnings array', async () => {
    arm({ response: 'fine' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.warnings, []);
  });
});

// agy's own `--print-timeout` (probed live on 1.1.24, plan 068 T4): the run
// exits 1 with EMPTY stderr and a result event that carries
// status: ERROR + error: "timeout waiting for response". Before this, the
// caller saw only "failed" and the word "timeout" appeared nowhere.
describe('runAgyPrint — result.error reaches stderr', () => {
  const TIMEOUT_ERROR = 'timeout waiting for response';

  it('names the reason when agy exits non-zero with empty stderr', async () => {
    arm({ status: 'ERROR', error: TIMEOUT_ERROR, exitCode: 1 });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.match(res.stderr, /agent-runtime: agy reported error: timeout waiting for response/);
  });

  it('adds the reason beside the status word when agy exits 0', async () => {
    arm({ status: 'ERROR', error: TIMEOUT_ERROR });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.match(res.stderr, /"ERROR", not SUCCESS/);
    assert.match(res.stderr, /agent-runtime: agy reported error: timeout waiting for response/);
  });

  it('stays silent when the result carries no error field', async () => {
    arm({ response: 'fine' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.stderr.includes('agy reported error'), false);
  });
});

describe('parseAgyStream — resultError', () => {
  it('is null without an error field and the string with one', () => {
    const line = (extra) =>
      JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', ...extra } }) + '\n';
    assert.equal(parseAgyStream(line({})).resultError, null);
    assert.equal(parseAgyStream(line({ error: 'timeout waiting for response' })).resultError,
      'timeout waiting for response');
    assert.equal(parseAgyStream(line({ error: '' })).resultError, null, 'empty string is not a reason');
  });
});

// Plan 085 T2: structured `denied_actions` (agy 1.1.27) parsing, merging
// with the stderr sentinel, and the field on `runAgyPrint`'s result.
const READ_URL_MEMBER = { action: 'read_url', display_name: 'ReadUrlContent' };

describe('normalizeDeniedActions', () => {
  it('normalizes the verbatim 1.1.27 single-member fixture', () => {
    assert.deepEqual(normalizeDeniedActions([READ_URL_MEMBER]), [
      { action: 'read_url', displayName: 'ReadUrlContent', source: 'json' },
    ]);
  });

  it('accepts several distinct members', () => {
    const out = normalizeDeniedActions([
      READ_URL_MEMBER,
      { action: 'run_command', display_name: 'RunCommand' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].action, 'read_url');
    assert.equal(out[1].action, 'run_command');
  });

  it('skips malformed members: missing action, non-string action, non-object, blank after sanitizing', () => {
    const out = normalizeDeniedActions([
      { display_name: 'NoAction' },
      { action: 42 },
      'not-an-object',
      null,
      { action: '   ' },
      READ_URL_MEMBER,
    ]);
    assert.deepEqual(out, [{ action: 'read_url', displayName: 'ReadUrlContent', source: 'json' }]);
  });

  it('deduplicates exact repeats (same action + displayName)', () => {
    const out = normalizeDeniedActions([READ_URL_MEMBER, { ...READ_URL_MEMBER }, READ_URL_MEMBER]);
    assert.equal(out.length, 1);
  });

  it('keeps two members with the same action but a different displayName distinct', () => {
    const out = normalizeDeniedActions([
      READ_URL_MEMBER,
      { action: 'read_url', display_name: 'OtherName' },
    ]);
    assert.equal(out.length, 2);
  });

  it('caps the list at MAX_DENIED_ACTIONS', () => {
    const many = Array.from({ length: MAX_DENIED_ACTIONS + 10 }, (_, i) => ({
      action: `tool_${i}`, display_name: `Tool ${i}`,
    }));
    assert.equal(normalizeDeniedActions(many).length, MAX_DENIED_ACTIONS);
  });

  it('caps each string at MAX_DENIED_ACTION_STRING_LENGTH and neutralises control characters', () => {
    const longAction = 'a'.repeat(300);
    const withControlChars = `read\x00_\x1furl\x7f`;
    const out = normalizeDeniedActions([
      { action: longAction },
      { action: withControlChars, display_name: 'x\x01y' },
    ]);
    assert.equal(out[0].action.length, MAX_DENIED_ACTION_STRING_LENGTH);
    assert.equal(out[1].action, 'read_url');
    assert.equal(out[1].displayName, 'xy');
  });

  it('accepts a member with no display_name (null, not a missing key)', () => {
    assert.deepEqual(normalizeDeniedActions([{ action: 'read_url' }]), [
      { action: 'read_url', displayName: null, source: 'json' },
    ]);
  });

  it('returns an empty array for a non-array, undefined, or empty input', () => {
    assert.deepEqual(normalizeDeniedActions(undefined), []);
    assert.deepEqual(normalizeDeniedActions('not-a-list'), []);
    assert.deepEqual(normalizeDeniedActions([]), []);
  });
});

describe('mergeDeniedActions', () => {
  const jsonList = [{ action: 'read_url', displayName: 'ReadUrlContent', source: 'json' }];
  const sentinel = { tool: 'read_file', line: 'jetski: ... auto-denied ...' };

  it('the JSON list wins when present, even alongside a sentinel', () => {
    assert.deepEqual(mergeDeniedActions(jsonList, sentinel), jsonList);
  });

  it('falls back to one stderr-sourced member when there is no JSON list', () => {
    assert.deepEqual(mergeDeniedActions(null, sentinel), [
      { action: 'read_file', displayName: null, source: 'stderr' },
    ]);
    assert.deepEqual(mergeDeniedActions([], sentinel), [
      { action: 'read_file', displayName: null, source: 'stderr' },
    ]);
  });

  it('is null when neither source has anything', () => {
    assert.equal(mergeDeniedActions(null, null), null);
    assert.equal(mergeDeniedActions([], null), null);
  });
});

describe('parseAgyStream — deniedActions', () => {
  it('is null when the result has no denied_actions field', () => {
    const line = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }) + '\n';
    assert.equal(parseAgyStream(line).deniedActions, null);
  });

  it('normalizes the verbatim 1.1.27 fixture', () => {
    const line = resultLine({ denied_actions: [READ_URL_MEMBER] }) + '\n';
    assert.deepEqual(parseAgyStream(line).deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', source: 'json' },
    ]);
  });

  it('keeps the last result event\'s denied_actions when several are present', () => {
    const first = resultLine({ denied_actions: [READ_URL_MEMBER] });
    const second = resultLine({ denied_actions: [{ action: 'run_command' }] });
    const out = parseAgyStream(`${first}\n${second}\n`);
    assert.deepEqual(out.deniedActions, [{ action: 'run_command', displayName: null, source: 'json' }]);
  });
});

describe('runAgyPrint — deniedActions on the result', () => {
  it('structured-only: JSON denied_actions with no stderr sentinel', async () => {
    arm({ response: 'answer', deniedActions: [READ_URL_MEMBER] });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.deepEqual(res.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', source: 'json' },
    ]);
  });

  it('stderr-only: the sentinel with no JSON denied_actions field (older agy)', async () => {
    arm({ response: '', stderr: DENIAL_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.deepEqual(res.deniedActions, [{ action: 'read_file', displayName: null, source: 'stderr' }]);
  });

  it('both together: the JSON list wins and the stderr member is not duplicated', async () => {
    arm({ response: 'answer', stderr: DENIAL_LINE, deniedActions: [READ_URL_MEMBER] });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.deniedActions.length, 1);
    assert.equal(res.deniedActions[0].action, 'read_url');
  });

  it('several members reach the result unduplicated', async () => {
    arm({
      response: 'answer',
      deniedActions: [READ_URL_MEMBER, { action: 'run_command', display_name: 'RunCommand' }],
    });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.deniedActions.length, 2);
  });

  it('is null on a clean run with no denial at all', async () => {
    arm({ response: 'fine' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.deniedActions, null);
  });

  it('is still reported on a non-SUCCESS result (UNVERIFIED shape, but must not crash)', async () => {
    arm({ response: '', status: 'CANCELED', deniedActions: [READ_URL_MEMBER] });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.deepEqual(res.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', source: 'json' },
    ]);
  });

  // Item 1: "keep the existing fail-vs-warn decision... exactly as today".
  // That decision is keyed on the stderr sentinel alone, so a JSON-only
  // denial (no stderr line) with an empty response stays `completed` — the
  // new data is detail, never a second way to fail a run. The t0a live
  // fixture always carries both together (deniedActions here would be
  // reported as a warning-free `completed` run without ever surfacing in
  // `warnings`, which only the sentinel path populates).
  it('a JSON-only denial with an empty response does not change the completed/failed decision', async () => {
    arm({ response: '', deniedActions: [READ_URL_MEMBER] });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.warnings, []);
    assert.equal(res.denial, null);
    assert.deepEqual(res.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', source: 'json' },
    ]);
  });
});

// The verb-level behaviour (per-verb hint, `--json` details.warnings) is
// covered end to end in tests/denial-verbs.test.mjs with a fake agy binary:
// capturing process.stdout in-process races node:test's reporter once the
// spawn mock yields a macrotask.
