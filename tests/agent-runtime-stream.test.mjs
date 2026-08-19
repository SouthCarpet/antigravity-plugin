/**
 * Tests for the stdin stream-json transport added to runAgyPrint /
 * spawnAgyDetached — the prompt now travels over stdin as a single NDJSON
 * line instead of `--print <prompt>` on argv, because Windows'
 * `CreateProcess` caps a spawned command line at ~32K chars and fails
 * outright above that (Win32 error 206 / Node `ENAMETOOLONG`); review/
 * rescue/task briefs routinely exceed it.
 *
 * Covers `parseAgyStream` directly (pure function, no spawn involved), plus
 * the new result-event-driven status rules against a mocked
 * `node:child_process.spawn` — same mocking style as
 * tests/agent-runtime-vision.test.mjs (installed before agent-runtime.mjs
 * is imported). Never spawns the real `agy`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

const spawnCalls = [];
let nextEvents = [];
let nextExitCode = 0;

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  child.stdin = new EventEmitter();
  child.stdin.written = '';
  child.stdin.write = (chunk) => { child.stdin.written += chunk; return true; };
  child.stdin.end = () => {};
  return child;
}

mock.module('node:child_process', {
  namedExports: {
    spawn: (bin, args, opts) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, opts, child });
      setImmediate(() => {
        for (const chunk of nextEvents) child.stdout.emit('data', chunk);
        child.emit('exit', nextExitCode);
      });
      return child;
    },
  },
});

const { runAgyPrint, spawnAgyDetached, parseAgyStream } = await import(
  '../scripts/lib/agent-runtime.mjs'
);

function resultLine(overrides = {}) {
  return JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-abc',
      status: 'SUCCESS',
      response: 'final answer text',
      duration_seconds: 1.9,
      num_turns: 1,
      usage: {
        input_tokens: 15853, output_tokens: 4, thinking_tokens: 0,
        cache_read_tokens: 0, total_tokens: 15857,
      },
      ...overrides,
    },
  });
}

const INIT_LINE = JSON.stringify({
  event: 'init',
  conversation_id: 'c-abc',
  init: { model: 'gemini-3.6-flash-high', cwd: '/x', tools: [] },
});
const STEP_LINE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'c-abc', step_index: 0, state: 'DONE',
    step_type: 'agent_response', text_delta: 'partial',
  },
});

// ───────────────────────────── parseAgyStream ─────────────────────────────

describe('parseAgyStream', () => {
  it('extracts response/usage/durationSeconds/conversationId/resultStatus from a recorded fixture', () => {
    const text = [INIT_LINE, STEP_LINE, resultLine()].join('\n') + '\n';
    const parsed = parseAgyStream(text);
    assert.equal(parsed.sawResult, true);
    assert.equal(parsed.response, 'final answer text');
    assert.equal(parsed.usage.total_tokens, 15857);
    assert.equal(parsed.durationSeconds, 1.9);
    assert.equal(parsed.conversationId, 'c-abc');
    assert.equal(parsed.resultStatus, 'SUCCESS');
  });

  it('reassembles a result line that arrived split across two chunks', () => {
    const full = resultLine();
    const splitPoint = Math.floor(full.length / 2);
    const chunk1 = full.slice(0, splitPoint);
    const chunk2 = full.slice(splitPoint) + '\n';
    const parsed = parseAgyStream(chunk1 + chunk2);
    assert.equal(parsed.sawResult, true);
    assert.equal(parsed.response, 'final answer text');
    assert.equal(parsed.usage.total_tokens, 15857);
  });

  it('sawResult is false when no result event is present — nothing is guessed', () => {
    const text = [INIT_LINE, STEP_LINE].join('\n') + '\n';
    const parsed = parseAgyStream(text);
    assert.equal(parsed.sawResult, false);
    assert.equal(parsed.response, null);
    assert.equal(parsed.usage, null);
    assert.equal(parsed.durationSeconds, null);
    assert.equal(parsed.conversationId, null);
    assert.equal(parsed.resultStatus, null);
  });

  it('returns the empty shape for empty or non-string input', () => {
    assert.equal(parseAgyStream('').sawResult, false);
    assert.equal(parseAgyStream(undefined).sawResult, false);
  });

  it('skips torn/unparseable lines instead of throwing', () => {
    const text = '{not valid json\n' + resultLine() + '\n';
    const parsed = parseAgyStream(text);
    assert.equal(parsed.sawResult, true);
    assert.equal(parsed.response, 'final answer text');
  });
});

// ───────────────────────────── runAgyPrint — transport ─────────────────────────────

describe('runAgyPrint — stdin stream-json transport', () => {
  it('spawns with --input-format stream-json --output-format stream-json --print "" and the prompt never lands in argv', async () => {
    spawnCalls.length = 0;
    nextEvents = [resultLine() + '\n'];
    nextExitCode = 0;
    const prompt = 'a normal prompt';
    await runAgyPrint({ prompt, bin: 'agy' });
    const { args } = spawnCalls[0];
    assert.deepEqual(
      args.slice(-6),
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print', ''],
    );
    assert.equal(args.includes(prompt), false);
  });

  it('writes the prompt as a single NDJSON line to stdin then ends it', async () => {
    spawnCalls.length = 0;
    nextEvents = [resultLine() + '\n'];
    nextExitCode = 0;
    const prompt = 'hello world';
    await runAgyPrint({ prompt, bin: 'agy' });
    const { child } = spawnCalls[0];
    const written = child.stdin.written.trim();
    assert.equal(written.split('\n').length, 1, 'exactly one NDJSON line');
    const parsed = JSON.parse(written);
    // agy 1.1.15 contract: top-level discriminator is `event`, not `type` —
    // the type-shape is rejected with 'missing the "event" field'.
    assert.deepEqual(parsed, {
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    });
  });

  it('a >40KB prompt never lands in argv (no arg exceeds 500 chars), and its full bytes reach stdin', async () => {
    spawnCalls.length = 0;
    nextEvents = [resultLine() + '\n'];
    nextExitCode = 0;
    const prompt = 'x'.repeat(46 * 1024) + ' end-marker';
    await runAgyPrint({ prompt, bin: 'agy' });
    const { args, child } = spawnCalls[0];
    for (const a of args) {
      assert.ok(a.length <= 500, `spawn arg exceeded 500 chars (${a.length})`);
    }
    const line = JSON.parse(child.stdin.written.trim());
    assert.equal(line.message.content[0].text, prompt);
    assert.equal(line.message.content[0].text.length, prompt.length);
  });

  it('exitCode 0 with a SUCCESS result event: completed, stdout=response, usage/duration/conversationId populated (no outputFormat needed)', async () => {
    spawnCalls.length = 0;
    nextEvents = [resultLine() + '\n'];
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'final answer text');
    assert.equal(res.usage.total_tokens, 15857);
    assert.equal(res.durationSeconds, 1.9);
    assert.equal(res.agyConversationId, 'c-abc');
    assert.ok(res.rawStdout.includes('"event":"result"'));
  });

  it('exitCode 0 with NO result event: failed, stderr explains a truncated stream — never a silent success', async () => {
    spawnCalls.length = 0;
    nextEvents = [INIT_LINE + '\n', STEP_LINE + '\n'];
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.match(res.stderr, /without a result event/);
  });

  it('a result event with a non-SUCCESS status: failed, status folded into stderr', async () => {
    spawnCalls.length = 0;
    nextEvents = [resultLine({ status: 'ERROR' }) + '\n'];
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'failed');
    assert.match(res.stderr, /ERROR/);
  });

  it('flags auth_required when the OAuth URL is embedded in a completed result.response', async () => {
    spawnCalls.length = 0;
    const authUrl = 'https://accounts.google.com/o/oauth2/auth?abc';
    nextEvents = [resultLine({ response: `Authentication required. Please visit ${authUrl}` }) + '\n'];
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'auth_required');
    assert.equal(res.oauthUrl, authUrl);
  });
});

// ───────────────────────────── runAgyPrint — onText ─────────────────────────────

function stepUpdateLine(textDelta, overrides = {}) {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: 'c-abc', step_index: 0, state: 'IN_PROGRESS',
      step_type: 'agent_response', text_delta: textDelta,
      ...overrides,
    },
  });
}

describe('runAgyPrint — onText (step_update.text_delta) callback', () => {
  it('receives exactly the text_delta strings from a recorded stream, and nothing for init/result lines', async () => {
    spawnCalls.length = 0;
    nextEvents = [
      INIT_LINE + '\n',
      stepUpdateLine('Hello, ') + '\n',
      stepUpdateLine('world!') + '\n',
      resultLine() + '\n',
    ];
    nextExitCode = 0;
    const seen = [];
    await runAgyPrint({ prompt: 'p', bin: 'agy', onText: (delta) => seen.push(delta) });
    assert.deepEqual(seen, ['Hello, ', 'world!']);
  });

  it('reassembles a step_update line split across two chunks before firing onText', async () => {
    spawnCalls.length = 0;
    const full = stepUpdateLine('reassembled text');
    const splitPoint = Math.floor(full.length / 2);
    nextEvents = [full.slice(0, splitPoint), full.slice(splitPoint) + '\n'];
    nextExitCode = 0;
    const seen = [];
    await runAgyPrint({ prompt: 'p', bin: 'agy', onText: (delta) => seen.push(delta) });
    assert.deepEqual(seen, ['reassembled text']);
  });

  it('skips step_update events with an empty or missing text_delta', async () => {
    spawnCalls.length = 0;
    nextEvents = [
      stepUpdateLine('') + '\n',
      JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: 'c-abc', step_index: 0, state: 'DONE', step_type: 'checkpoint' },
      }) + '\n',
      stepUpdateLine('kept') + '\n',
    ];
    nextExitCode = 0;
    const seen = [];
    await runAgyPrint({ prompt: 'p', bin: 'agy', onText: (delta) => seen.push(delta) });
    assert.deepEqual(seen, ['kept']);
  });

  it('raw onStdout pass-through is unaffected by onText (both fire from the same stream)', async () => {
    spawnCalls.length = 0;
    nextEvents = [stepUpdateLine('x') + '\n', resultLine() + '\n'];
    nextExitCode = 0;
    const seenText = [];
    const seenRaw = [];
    await runAgyPrint({
      prompt: 'p', bin: 'agy',
      onText: (delta) => seenText.push(delta),
      onStdout: (chunk) => seenRaw.push(chunk),
    });
    assert.deepEqual(seenText, ['x']);
    assert.equal(seenRaw.join(''), nextEvents.join(''));
  });

  it('is a no-op (never invoked, no crash) when omitted', async () => {
    spawnCalls.length = 0;
    nextEvents = [stepUpdateLine('ignored') + '\n', resultLine() + '\n'];
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'p', bin: 'agy' });
    assert.equal(res.status, 'completed');
  });
});

describe('spawnAgyDetached — stdin stream-json transport', () => {
  it('spawns with stdio [pipe, pipe, pipe] and writes the NDJSON prompt to stdin', () => {
    spawnCalls.length = 0;
    const prompt = 'detached prompt';
    const child = spawnAgyDetached({ prompt, bin: 'agy' });
    assert.equal(spawnCalls[0].opts.stdio[0], 'pipe');
    const line = JSON.parse(spawnCalls[0].child.stdin.written.trim());
    assert.equal(line.message.content[0].text, prompt);
    assert.ok(child);
  });

  it('spawns with the same always-on stream-json tail as runAgyPrint', () => {
    spawnCalls.length = 0;
    spawnAgyDetached({ prompt: 'p', bin: 'agy' });
    const { args } = spawnCalls[0];
    assert.deepEqual(
      args.slice(-6),
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print', ''],
    );
  });
});
