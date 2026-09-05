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
 * `scripts/lib/process-adapter.mjs` — the owned seam agent-runtime.mjs
 * spawns through, faked the same way tests/agent-runtime-vision.test.mjs
 * fakes it (installed before agent-runtime.mjs is imported). Never spawns
 * the real `agy`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { terminateProcessTree } from '../scripts/lib/process.mjs';

const spawnCalls = [];
let nextEvents = [];
let nextExitCode = 0;
let autoExit = true;
let exitOnSigkill = false;

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === 'SIGKILL' && exitOnSigkill) setImmediate(() => {
      child.emit('exit', null, 'SIGKILL');
      child.emit('close', null, 'SIGKILL');
    });
    return true;
  };
  child.stdin = new EventEmitter();
  child.stdin.written = '';
  child.stdin.write = (chunk) => { child.stdin.written += chunk; return true; };
  child.stdin.end = () => {};
  return child;
}

mock.module('../scripts/lib/process-adapter.mjs', {
  namedExports: {
    spawn: (bin, args, opts) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, opts, child });
      if (autoExit) {
        setImmediate(() => {
          for (const chunk of nextEvents) child.stdout.emit('data', chunk);
          child.emit('exit', nextExitCode);
          child.emit('close', nextExitCode);
        });
      }
      return child;
    },
  },
});

const { runAgyPrint, spawnAgyDetached, parseAgyStream, probeAgy } = await import(
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

// Oracle: brief 076-T3 R2. Control exit and close independently to reproduce
// inherited pipes and data delivered after the process has already exited.
describe('bounded stdio draining', () => {
  it('keeps a SUCCESS answer delivered between exit and close', async () => {
    autoExit = false;
    try {
      const pending = runAgyPrint({ prompt: 'p', bin: 'agy' });
      const child = spawnCalls.at(-1).child;
      child.emit('exit', 0);
      child.stdout.emit('data', resultLine({ response: 'late answer' }) + '\n');
      child.emit('close', 0);
      const result = await pending;
      assert.equal(result.status, 'completed');
      assert.equal(result.stdout, 'late answer');
      assert.deepEqual(result.warnings, []);
    } finally { autoExit = true; }
  });

  it('classifies a denial delivered between exit and close', async () => {
    autoExit = false;
    try {
      const pending = runAgyPrint({ prompt: 'p', bin: 'agy' });
      const child = spawnCalls.at(-1).child;
      child.stdout.emit('data', resultLine({ response: '' }) + '\n');
      child.emit('exit', 0);
      child.stderr.emit('data', 'tool "read_file" was auto-denied\n');
      child.emit('close', 0);
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.denial.tool, 'read_file');
    } finally { autoExit = true; }
  });

  it('destroys inherited pipes at the five-second drain deadline and warns', async (t) => {
    autoExit = false;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = runAgyPrint({ prompt: 'p', bin: 'agy' });
      const child = spawnCalls.at(-1).child;
      const destroyed = [];
      child.stdin.destroy = () => destroyed.push('stdin');
      child.stdout.destroy = () => destroyed.push('stdout');
      child.stderr.destroy = () => destroyed.push('stderr');
      child.stdout.emit('data', resultLine({ response: 'kept' }) + '\n');
      child.emit('exit', 0);
      t.mock.timers.tick(5000);
      const result = await pending;
      assert.equal(result.status, 'completed');
      assert.equal(result.stdout, 'kept');
      assert.deepEqual(result.warnings, ['agy stdio did not close within 5000 ms after exit']);
      assert.deepEqual(destroyed, ['stdin', 'stdout', 'stderr']);
    } finally { autoExit = true; }
  });

  it('settles a spawn error immediately without exit or close', async () => {
    autoExit = false;
    try {
      const pending = runAgyPrint({ prompt: 'p', bin: 'agy' });
      spawnCalls.at(-1).child.emit('error', new Error('spawn denied'));
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.spawnError, 'spawn denied');
    } finally { autoExit = true; }
  });

  it('keeps the execution timer active after exit while pipes remain open', async (t) => {
    autoExit = false;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let terminated = false;
      const pending = runAgyPrint({
        prompt: 'p', bin: 'agy', timeoutMs: 50,
        terminateTree: async () => { terminated = true; },
      });
      const child = spawnCalls.at(-1).child;
      child.emit('exit', 0);
      t.mock.timers.tick(50);
      assert.equal(terminated, true);
      child.emit('close', 0);
      const result = await pending;
      assert.equal(result.status, 'timeout');
      assert.equal(result.errorMessage, 'agy did not finish within 50 ms');
    } finally { autoExit = true; }
  });

  it('reads a probe version delivered after exit', async () => {
    autoExit = false;
    try {
      const pending = probeAgy({ bin: 'agy' });
      const child = spawnCalls.at(-1).child;
      child.emit('exit', 0);
      child.stdout.emit('data', '1.2.3\n');
      child.emit('close', 0);
      assert.deepEqual(await pending, { ok: true, version: '1.2.3' });
    } finally { autoExit = true; }
  });

  it('clears both deadlines on close even while onSpawn is still persisting', async (t) => {
    // Oracle: R2 clears timers on close, not after an unrelated callback finishes.
    autoExit = false;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let releaseSpawn;
      const persisting = new Promise((resolve) => { releaseSpawn = resolve; });
      let terminated = false;
      const pending = runAgyPrint({
        prompt: 'p', bin: 'agy', timeoutMs: 50, onSpawn: () => persisting,
        terminateTree: async () => { terminated = true; },
      });
      const child = spawnCalls.at(-1).child;
      child.stdout.emit('data', resultLine({ response: 'done' }) + '\n');
      child.emit('exit', 0);
      child.emit('close', 0);
      t.mock.timers.tick(6000);
      releaseSpawn();
      const result = await pending;
      assert.equal(result.status, 'completed');
      assert.equal(terminated, false);
      assert.deepEqual(result.warnings, []);
    } finally { autoExit = true; }
  });

  it('bounds a probe whose inherited pipes never close', async (t) => {
    autoExit = false;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = probeAgy({ bin: 'agy', terminateTree: async () => {} });
      spawnCalls.at(-1).child.emit('exit', 0);
      t.mock.timers.tick(5000);
      assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
    } finally { autoExit = true; }
  });
});

// Oracle: brief 076-T3 R1 caps bytes, retains only pre-breach output, and
// fails even if a SUCCESS event preceded the oversized chunk.
describe('agy output caps', () => {
  for (const stream of ['stdout', 'stderr']) {
    it(`fails and terminates when ${stream} exceeds a four-byte cap`, async () => {
      autoExit = false;
      try {
        let terminated = false;
        const pending = runAgyPrint({
          prompt: 'p', bin: 'agy', maxStdoutBytes: 4, maxStderrBytes: 4,
          terminateTree: async () => { terminated = true; },
        });
        const child = spawnCalls.at(-1).child;
        child.stdout.emit('data', 'kept');
        child[stream].emit('data', 'ééé');
        child.stdout.emit('data', 'ignored after breach');
        child.emit('exit', 0);
        child.emit('close', 0);
        const result = await pending;
        assert.equal(terminated, true);
        assert.equal(result.status, 'failed');
        assert.equal(result.errorMessage, 'agy output exceeded 4 bytes');
        assert.equal(result.stdout, 'kept');
      } finally { autoExit = true; }
    });
  }

  it('accepts stdout exactly at the cap', async () => {
    nextEvents = [resultLine({ response: 'bounded' }) + '\n'];
    nextExitCode = 0;
    const result = await runAgyPrint({
      prompt: 'p', bin: 'agy', maxStdoutBytes: Buffer.byteLength(nextEvents[0]),
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.stdout, 'bounded');
  });

  it('fails a cap breach after SUCCESS and retains the preceding raw stream', async () => {
    autoExit = false;
    try {
      const answer = resultLine({ response: 'partial answer' }) + '\n';
      const pending = runAgyPrint({
        prompt: 'p', bin: 'agy', maxStderrBytes: 4, terminateTree: async () => {},
      });
      const child = spawnCalls.at(-1).child;
      child.stdout.emit('data', answer);
      child.stderr.emit('data', '12345');
      child.emit('exit', 0);
      child.emit('close', 0);
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.errorMessage, 'agy output exceeded 4 bytes');
      assert.equal(result.stdout, answer);
    } finally { autoExit = true; }
  });
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

  it('bounds timeout and escalates when a child ignores SIGTERM', async () => {
    spawnCalls.length = 0;
    autoExit = false;
    exitOnSigkill = true;
    const started = Date.now();
    try {
      const res = await runAgyPrint({
        prompt: 'p', bin: 'agy', timeoutMs: 10,
        terminationGraceMs: 10, forceKillGraceMs: 20,
        terminateTree: (_pid, options) => terminateProcessTree(123, {
          ...options, platform: 'linux',
          probe: () => !spawnCalls[0].child.killSignals.includes('SIGKILL'),
          killImpl: (_target, signal) => spawnCalls[0].child.kill(signal),
        }),
      });
      assert.equal(res.status, 'timeout');
      assert.ok(Date.now() - started < 500, 'timeout escalation must be bounded');
      assert.deepEqual(spawnCalls[0].child.killSignals, ['SIGTERM', 'SIGKILL']);
    } finally {
      autoExit = true;
      exitOnSigkill = false;
    }
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
