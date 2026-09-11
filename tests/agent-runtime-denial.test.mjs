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
  detectPrintTimeoutTruncation, extractFatalErrorMarker,
  MAX_PRINT_TIMEOUT_LIMIT_LENGTH, MAX_FATAL_ERROR_LENGTH,
} = await import('../scripts/lib/agent-runtime.mjs');

// Verbatim from agy 1.2.1 stderr, measured through the plugin's own
// stream-json transport (plan 086 T1, controller correction,
// t0d-stream-json-print-timeout.txt). Only `[agy] print timeout` and
// `returning partial output` are treated as stable; agy may reword the
// middle (the duration and the "with turn in progress" clause).
const PRINT_TIMEOUT_LINE =
  '[agy] print timeout after 25s with turn in progress; returning partial output';

// Verbatim from agy 1.2.1 stderr (t0-agy-error-marker.txt).
const FATAL_ERROR_LINE =
  'error: invalid model selection (--model "no-such-model-xyz" --effort ""): model no-such-model-xyz is not recognized as a known model or custom model in settings';

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

  // T3 carry-over item 9: the sentinel-sourced action is free text captured
  // by detectAutoDenial's quote regex, not a bounded schema field like the
  // JSON path's members — it must go through the same sanitiser.
  it('sanitises a control character in the sentinel tool name', () => {
    const dirty = { tool: 'read\x00_\x1ffile\x7f', line: 'jetski: ... auto-denied ...' };
    assert.deepEqual(mergeDeniedActions(null, dirty), [
      { action: 'read_file', displayName: null, source: 'stderr' },
    ]);
  });

  it('caps an over-long sentinel tool name at MAX_DENIED_ACTION_STRING_LENGTH', () => {
    const longTool = 'a'.repeat(300);
    const out = mergeDeniedActions(null, { tool: longTool, line: 'jetski: ... auto-denied ...' });
    assert.equal(out[0].action.length, MAX_DENIED_ACTION_STRING_LENGTH);
  });

  it('falls back to "unknown" when the sentinel tool sanitises to nothing', () => {
    const out = mergeDeniedActions(null, { tool: '\x00\x01', line: 'jetski: ... auto-denied ...' });
    assert.deepEqual(out, [{ action: 'unknown', displayName: null, source: 'stderr' }]);
  });
});

// T3 carry-over item 8: the exact `result` line from the t0a live fixture
// (agy 1.1.27, A:\projects-vault\animus\data\agent-runs\085_antigravity-plugin-1.3\t0a-denied-stream-stdout.txt),
// copied unchanged, through parseAgyStream.
describe('parseAgyStream — the t0a live fixture, verbatim', () => {
  const T0A_RESULT_LINE = '{"event":"result","result":{"conversation_id":"55443200-9863-4c41-8c38-709982557509","status":"SUCCESS","response":"","duration_seconds":2.2773574,"num_turns":1,"usage":{"input_tokens":5999,"output_tokens":135,"thinking_tokens":94,"cache_read_tokens":8125,"total_tokens":6134},"denied_actions":[{"action":"read_url","display_name":"ReadUrlContent"}]}}';

  it('normalises deniedActions from the unmodified fixture line', () => {
    const out = parseAgyStream(T0A_RESULT_LINE + '\n');
    assert.equal(out.sawResult, true);
    assert.equal(out.resultStatus, 'SUCCESS');
    assert.deepEqual(out.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', source: 'json' },
    ]);
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

// Plan 086 T1: agy's print-timeout truncation marker (>= 1.1.28) and its
// stable `error:` fatal marker.
describe('detectPrintTimeoutTruncation', () => {
  it('matches the verbatim measured line and captures the duration', () => {
    assert.deepEqual(detectPrintTimeoutTruncation(PRINT_TIMEOUT_LINE), { limit: '25s' });
  });

  it('matches with noise before and after, and a null limit when no duration is captured', () => {
    const noDuration = '[agy] print timeout with turn in progress; returning partial output';
    assert.deepEqual(
      detectPrintTimeoutTruncation(`noise\n${noDuration}\nnoise`),
      { limit: null },
    );
  });

  it('does not match a line without the partial-output clause', () => {
    const noPartialClause = '[agy] print timeout after 25s with turn in progress';
    assert.equal(detectPrintTimeoutTruncation(noPartialClause), null);
  });

  it('returns null when nothing matches, empty, or undefined', () => {
    assert.equal(detectPrintTimeoutTruncation('CLI settings initialized\n'), null);
    assert.equal(detectPrintTimeoutTruncation(''), null);
    assert.equal(detectPrintTimeoutTruncation(undefined), null);
  });

  it('strips a control character embedded in the captured duration', () => {
    const dirty = '[agy] print timeout after 25\x00s with turn in progress; returning partial output';
    assert.deepEqual(detectPrintTimeoutTruncation(dirty), { limit: '25s' });
  });

  it('caps an over-long captured duration at MAX_PRINT_TIMEOUT_LIMIT_LENGTH', () => {
    const longDuration = 'a'.repeat(200) + 's';
    const line = `[agy] print timeout after ${longDuration} with turn in progress; returning partial output`;
    const out = detectPrintTimeoutTruncation(line);
    assert.equal(out.limit.length, MAX_PRINT_TIMEOUT_LIMIT_LENGTH);
  });
});

describe('extractFatalErrorMarker', () => {
  it('extracts the verbatim measured line', () => {
    assert.equal(extractFatalErrorMarker(FATAL_ERROR_LINE), FATAL_ERROR_LINE);
  });

  it('the first error: line wins when several are present', () => {
    const two = 'error: first reason\nerror: second reason\n';
    assert.equal(extractFatalErrorMarker(two), 'error: first reason');
  });

  it('returns null when no line starts with error:', () => {
    assert.equal(extractFatalErrorMarker('CLI settings initialized\n'), null);
    assert.equal(extractFatalErrorMarker(''), null);
    assert.equal(extractFatalErrorMarker(undefined), null);
  });

  it('strips control characters and caps at MAX_FATAL_ERROR_LENGTH', () => {
    const dirty = `error: bad\x00 model\x1f ${'x'.repeat(400)}`;
    const out = extractFatalErrorMarker(dirty);
    assert.equal(out.includes('\x00'), false);
    assert.equal(out.length, MAX_FATAL_ERROR_LENGTH);
  });
});

describe('runAgyPrint — agy print-timeout marker (plan 086 T1)', () => {
  it('non-empty response + marker -> completed, agyPrintTimeout set, a partial answer is still an answer', async () => {
    arm({ response: 'partial essay text...', stderr: PRINT_TIMEOUT_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'partial essay text...');
    assert.deepEqual(res.agyPrintTimeout, { limit: '25s' });
  });

  it('empty response + marker -> failed, the same empty-answer treatment a starved denial gets', async () => {
    arm({ response: '', stderr: PRINT_TIMEOUT_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.deepEqual(res.agyPrintTimeout, { limit: '25s' });
    assert.match(res.stderr, /agy's print timeout expired \(25s\) before producing any output/);
  });

  it('a whitespace-only response with the marker also fails (counts as empty)', async () => {
    arm({ response: ' \n\t ', stderr: PRINT_TIMEOUT_LINE });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
  });

  it('is null on a clean run with no marker at all', async () => {
    arm({ response: 'fine' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.agyPrintTimeout, null);
  });
});

describe('runAgyPrint — fatal error marker reaches errorMessage', () => {
  it('a plain exit-1 failure with no result event picks up the error: marker', async () => {
    spawnCalls.length = 0;
    nextStdout = [];
    nextStderr = [FATAL_ERROR_LINE + '\nAvailable models:\n  Gemini 3.8 Flash (High)\n'];
    nextExitCode = 1;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.equal(res.errorMessage, FATAL_ERROR_LINE);
  });

  it('a successful run never gets an errorMessage from this path', async () => {
    arm({ response: 'fine' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.equal(res.errorMessage, null);
  });

  it('a plugin-authored termination reason wins over agy\'s own error: marker', async () => {
    // An output-limit termination sets session.errorMessage synchronously as
    // the offending chunk arrives — before the child's exit is ever
    // processed — so that message must not be replaced even though agy's
    // stderr also happens to carry an error: line.
    spawnCalls.length = 0;
    nextStdout = [];
    nextStderr = [FATAL_ERROR_LINE + '\n'];
    nextExitCode = 1;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy', maxStderrBytes: 1 });
    assert.equal(res.status, 'failed');
    assert.match(res.errorMessage, /agy output exceeded 1 bytes/);
    assert.notEqual(res.errorMessage, FATAL_ERROR_LINE);
  });
});

// The verb-level behaviour (per-verb hint, `--json` details.warnings) is
// covered end to end in tests/denial-verbs.test.mjs with a fake agy binary:
// capturing process.stdout in-process races node:test's reporter once the
// spawn mock yields a macrotask.
