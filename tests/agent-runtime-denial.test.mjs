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

  // Plan 086 T5e F1: an "unexplained" empty response (no stderr sentinel, no
  // structured denial, no print-timeout marker) used to stay `completed` —
  // "a model may legitimately say nothing". None of the four verbs' prompts
  // ask for a genuinely silent answer (review/vision demand a fixed
  // non-empty shape; rescue/task forward the caller's prompt verbatim with
  // no silence contract — see `runAgyPrint`'s doc comment), so this is now a
  // failure like any other unexplained empty answer.
  it('SUCCESS + empty response + NO denial/timeout evidence now fails (was: stays completed)', async () => {
    arm({ response: '', stderr: 'CLI settings initialized: permissions=&{Allow:[]}' });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.equal(res.stdout, '');
    assert.deepEqual(res.warnings, []);
    assert.equal(res.denial, null);
    assert.match(res.stderr, /agent-runtime: agy reported SUCCESS with an empty response and no denial or timeout evidence to explain it/);
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

  // Plan 086 T5e F5: U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR),
  // and the C1 control range (U+0080-U+009F) survived the original
  // C0/DEL-only filter and could break a single-line stderr echo or a
  // markdown label across lines the same way a raw CR/LF would.
  it('strips U+2028, U+2029, and the C1 control range', () => {
    const dirty = 'read\u2028_\u2029url\u0090end';
    const out = normalizeDeniedActions([{ action: dirty }]);
    assert.equal(out[0].action, 'read_urlend');
    assert.doesNotMatch(out[0].action, /[\u2028\u2029\u0080-\u009f]/);
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
      { action: 'read_url', displayName: 'ReadUrlContent', target: null, source: 'json' },
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
      { action: 'read_url', displayName: 'ReadUrlContent', target: null, source: 'json' },
    ]);
  });

  it('keeps the last result event\'s denied_actions when several are present', () => {
    const first = resultLine({ denied_actions: [READ_URL_MEMBER] });
    const second = resultLine({ denied_actions: [{ action: 'run_command' }] });
    const out = parseAgyStream(`${first}\n${second}\n`);
    assert.deepEqual(out.deniedActions, [
      { action: 'run_command', displayName: null, target: null, source: 'json' },
    ]);
  });

  // Plan 086 T5e F2: a second `result` event used to merge field-by-field
  // (`?? out.X`), so a later event that omits a field silently kept the
  // earlier event's value for that field. A minimal `result` object (only
  // `status`) here has no `response`/`usage`/`denied_actions` at all; the
  // fix replaces the whole snapshot on each event, so none of the first
  // event's fields survive.
  it('a later result event with fewer fields replaces the whole snapshot, not just the ones it names', () => {
    const first = resultLine({
      response: 'first answer', usage: { total_tokens: 5 }, denied_actions: [READ_URL_MEMBER],
    });
    const secondBare = JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } });
    const out = parseAgyStream(`${first}\n${secondBare}\n`);
    assert.equal(out.response, null, 'the earlier response must not survive');
    assert.equal(out.usage, null, 'the earlier usage must not survive');
    assert.equal(out.deniedActions, null, 'the earlier deniedActions must not survive');
    assert.equal(out.resultStatus, 'SUCCESS');
    assert.equal(out.sawResult, true);
  });
});

// Plan 086 T3: agy's result.denied_actions names only the action; the
// denied target arrives separately, in a step_update event's tool error
// message (`permission check failed for <action> "<target>":`). These two
// fixtures are the verbatim step_update + result lines from
// t0e-denied-read-url-step.txt and t0c-ask-permission-headless.txt
// (086_antigravity-plugin-1.4 agent run, agy 1.2.1).
const T0E_STEP_LINE = '{"event":"step_update","step_update":{"conversation_id":"594b90eb-80e4-4271-8563-da2453f36f62","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"read_url_content","duration_seconds":0.127872,"tool_info":{"name":"read_url_content","parameters":{"Url":"https://example.com/"},"error":{"type":"TOOL_ERROR","message":"permission check failed for read_url \\"example.com\\": user denied permission for read_url(example.com)"}}}}';
const T0E_RESULT_LINE = '{"event":"result","result":{"conversation_id":"594b90eb-80e4-4271-8563-da2453f36f62","status":"SUCCESS","response":"","duration_seconds":3.4518673,"num_turns":1,"usage":{"input_tokens":5793,"output_tokens":193,"thinking_tokens":149,"cache_read_tokens":8124,"total_tokens":5986},"denied_actions":[{"action":"read_url","display_name":"ReadUrlContent"}]}}';

const T0C_STEP_LINE = '{"event":"step_update","step_update":{"conversation_id":"02358caf-ef58-47b4-8f58-2ef2c92a48cf","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello"},"error":{"type":"TOOL_ERROR","message":"permission check failed for command \\"echo hello\\": user denied permission to run command:\\necho hello"}}}}';
const T0C_RESULT_LINE = '{"event":"result","result":{"conversation_id":"02358caf-ef58-47b4-8f58-2ef2c92a48cf","status":"SUCCESS","response":"","duration_seconds":3.5404118,"num_turns":1,"usage":{"input_tokens":5790,"output_tokens":648,"thinking_tokens":581,"cache_read_tokens":8124,"total_tokens":6438},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}';

describe('parseAgyStream — denied-action target join, verbatim fixtures (plan 086 T3)', () => {
  it('t0e (read_url): joins the target parsed from the step_update error message', () => {
    const out = parseAgyStream(`${T0E_STEP_LINE}\n${T0E_RESULT_LINE}\n`);
    assert.deepEqual(out.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', target: 'example.com', source: 'json' },
    ]);
  });

  it('t0c (command): joins by the action name parsed from the message, never by tool_name', () => {
    // tool_name is "run_command"; the action inside the message and inside
    // denied_actions is "command". A tool_name-keyed join would never match.
    const out = parseAgyStream(`${T0C_STEP_LINE}\n${T0C_RESULT_LINE}\n`);
    assert.deepEqual(out.deniedActions, [
      { action: 'command', displayName: 'RunCommand', target: 'echo hello', source: 'json' },
    ]);
  });

  // Plan 086 T5e F2: `normalizeDeniedActions` keeps two members with the
  // same action but a different displayName distinct (a real shape — two
  // denied calls to the same tool for different reasons), so mapping every
  // same-action member onto the FIRST step_update target would give two
  // different denied calls the same target. Occurrence order: the Nth
  // same-action member gets the Nth same-action step_update target.
  it('two members with the same action but different targets each get their own target, in order', () => {
    const stepA = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ERROR', step_type: 'tool', tool_name: 'read_url_content',
        tool_info: { error: { message: 'permission check failed for read_url "first.example.com": denied' } },
      },
    });
    const stepB = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ERROR', step_type: 'tool', tool_name: 'read_url_content',
        tool_info: { error: { message: 'permission check failed for read_url "second.example.com": denied' } },
      },
    });
    const line = JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS', response: '',
        denied_actions: [
          { action: 'read_url', display_name: 'First' },
          { action: 'read_url', display_name: 'Second' },
        ],
      },
    }) + '\n';
    const out = parseAgyStream(`${stepA}\n${stepB}\n${line}`);
    assert.deepEqual(out.deniedActions, [
      { action: 'read_url', displayName: 'First', target: 'first.example.com', source: 'json' },
      { action: 'read_url', displayName: 'Second', target: 'second.example.com', source: 'json' },
    ]);
  });

  it('a member with no matching step keeps target: null', () => {
    const line = JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'call_mcp_tool' }] },
    }) + '\n';
    const out = parseAgyStream(`${T0E_STEP_LINE}\n${line}`);
    assert.deepEqual(out.deniedActions, [
      { action: 'call_mcp_tool', displayName: null, target: null, source: 'json' },
    ]);
  });

  it('a step whose action matches no denied_actions member is dropped, never appending a new member', () => {
    // Only the read_url step is present; "command" has no matching step, so
    // its member is still present with target: null and no extra member
    // was appended for the read_url step.
    const line = JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] },
    }) + '\n';
    const out = parseAgyStream(`${T0E_STEP_LINE}\n${line}`);
    assert.equal(out.deniedActions.length, 1);
    assert.equal(out.deniedActions[0].action, 'command');
    assert.equal(out.deniedActions[0].target, null);
  });

  it('ignores a step_update that is not an ERROR tool step', () => {
    const nonErrorStep = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'DONE', step_type: 'tool', tool_name: 'read_url_content',
        tool_info: { error: { message: 'permission check failed for read_url "example.com": denied' } },
      },
    });
    const line = JSON.stringify({
      event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_url' }] },
    }) + '\n';
    const out = parseAgyStream(`${nonErrorStep}\n${line}`);
    assert.equal(out.deniedActions[0].target, null);
  });

  it('sanitizes and caps the target the same way action/displayName are', () => {
    const dirty = 'a'.repeat(300) + '\x00\x1f';
    const stepLine = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ERROR', step_type: 'tool', tool_name: 'read_url_content',
        tool_info: { error: { message: `permission check failed for read_url "${dirty}": denied` } },
      },
    });
    const line = JSON.stringify({
      event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_url' }] },
    }) + '\n';
    const out = parseAgyStream(`${stepLine}\n${line}`);
    assert.equal(out.deniedActions[0].target.length, MAX_DENIED_ACTION_STRING_LENGTH);
    assert.doesNotMatch(out.deniedActions[0].target, /[\x00-\x1f\x7f]/);
  });

  it('deduplicated exact action+target repeats do not consume the MAX_DENIED_ACTIONS budget', () => {
    const repeatedStep = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ERROR', step_type: 'tool', tool_name: 'x',
        tool_info: { error: { message: 'permission check failed for read_url "example.com": denied' } },
      },
    });
    const repeats = Array.from({ length: MAX_DENIED_ACTIONS + 10 }, () => repeatedStep).join('\n');
    const distinctStep = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ERROR', step_type: 'tool', tool_name: 'x',
        tool_info: { error: { message: 'permission check failed for command "echo hi": denied' } },
      },
    });
    const line = JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS', response: '',
        denied_actions: [{ action: 'read_url' }, { action: 'command' }],
      },
    }) + '\n';
    const out = parseAgyStream(`${repeats}\n${distinctStep}\n${line}`);
    assert.equal(out.deniedActions[0].target, 'example.com');
    assert.equal(out.deniedActions[1].target, 'echo hi');
  });

  it('caps the number of distinct step_update-derived targets at MAX_DENIED_ACTIONS', () => {
    const steps = Array.from({ length: MAX_DENIED_ACTIONS + 1 }, (_, i) => JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ERROR', step_type: 'tool', tool_name: 'x',
        tool_info: { error: { message: `permission check failed for tool_${i} "target_${i}": denied` } },
      },
    })).join('\n');
    // The scan stops at MAX_DENIED_ACTIONS distinct entries, so the one
    // beyond the cap (index MAX_DENIED_ACTIONS) was never collected.
    const line = JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: '', denied_actions: [{ action: `tool_${MAX_DENIED_ACTIONS}` }] },
    }) + '\n';
    const out = parseAgyStream(`${steps}\n${line}`);
    assert.equal(out.deniedActions[0].target, null);
  });
});

describe('runAgyPrint — deniedActions on the result', () => {
  // Plan 086 T5e F1: "a JSON denial with a real answer still completes and
  // keeps the warning" — a structured JSON-only denial (no stderr sentinel)
  // is reported as a warning the same way a sentinel-detected denial is, so
  // an answered run is never silently missing that context.
  it('structured-only: JSON denied_actions with no stderr sentinel completes and warns', async () => {
    arm({ response: 'answer', deniedActions: [READ_URL_MEMBER] });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', target: null, source: 'json' },
    ]);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /read_url \(ReadUrlContent\)/);
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
      { action: 'read_url', displayName: 'ReadUrlContent', target: null, source: 'json' },
    ]);
  });

  // Plan 086 T5e F1: a structured JSON-only denial (no stderr sentinel) is
  // now denial evidence exactly like the sentinel is, so an empty response
  // is `failed`, not `completed` with nothing in it (the bug the 1.1.0 work
  // existed to close). Before this fix the item 1 comment here read "the new
  // data is detail, never a second way to fail a run" — that was the bug.
  it('a JSON-only denial with an empty response now fails (was: stayed completed)', async () => {
    arm({ response: '', deniedActions: [READ_URL_MEMBER] });
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.deepEqual(res.warnings, []);
    assert.equal(res.denial, null);
    assert.deepEqual(res.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', target: null, source: 'json' },
    ]);
    assert.match(res.stderr, /agent-runtime: agy produced no output; agy reported 1 denied action\(s\) with no stderr auto-denial line: read_url \(ReadUrlContent\)/);
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
