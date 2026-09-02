/**
 * Tests for runAgyPrint's `outputFormat` parameter — now a backward-compat
 * no-op. agy always runs over the stream-json transport (see
 * scripts/lib/agent-runtime.mjs's runAgyPrint doc comment); `usage`,
 * `durationSeconds`, `agyConversationId`, and `rawStdout` are populated from
 * the NDJSON `result` event on every completed run, whether or not a caller
 * still passes `outputFormat: 'json'`.
 *
 * `scripts/lib/process-adapter.mjs` — the owned seam agent-runtime.mjs
 * spawns through — is faked the same way tests/agent-runtime-vision.test.mjs
 * fakes it (installed before agent-runtime.mjs is imported) rather than
 * shelling out to a real fake binary: this repo's other real-spawn fixture
 * (agent-runtime-deep.test.mjs) hardcodes POSIX `/tmp` + `#!/bin/sh` stubs,
 * which do not run on native Windows. The fake lets us control exactly what
 * stdout runAgyPrint sees, which is what these assertions are actually
 * about.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

const spawnCalls = [];
let nextStdout = '';
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

mock.module('../scripts/lib/process-adapter.mjs', {
  namedExports: {
    spawn: (bin, args, opts) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, opts, child });
      setImmediate(() => {
        if (nextStdout) child.stdout.emit('data', nextStdout);
        child.emit('exit', nextExitCode);
      });
      return child;
    },
  },
});

const { runAgyPrint } = await import('../scripts/lib/agent-runtime.mjs');

// Real agy 1.1.14 stream-json result event, probed live 2026-08-18 (measured
// token counts). A real stream also carries init/step_update lines before
// this, but runAgyPrint only extracts fields from `result`.
const RESULT_LINE = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'c-123',
    status: 'SUCCESS',
    response: 'OK from fake agy\n',
    duration_seconds: 1.73,
    num_turns: 1,
    usage: {
      input_tokens: 18351, output_tokens: 28, thinking_tokens: 24,
      cache_read_tokens: 0, total_tokens: 18379,
    },
  },
}) + '\n';

describe('runAgyPrint — outputFormat is a backward-compat no-op', () => {
  it('outputFormat: "json" no longer adds --output-format json; the tail is always stream-json', async () => {
    spawnCalls.length = 0;
    nextStdout = RESULT_LINE;
    nextExitCode = 0;
    await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    const { args } = spawnCalls[0];
    // Exactly one --output-format in argv, and its value is stream-json —
    // never the old bare "json".
    assert.equal(args.filter((a) => a === '--output-format').length, 1);
    const fmtIdx = args.indexOf('--output-format');
    assert.equal(args[fmtIdx + 1], 'stream-json');
  });

  it('outputFormat omitted vs "json": identical spawn args', async () => {
    spawnCalls.length = 0;
    nextStdout = RESULT_LINE;
    nextExitCode = 0;
    await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    const withFlag = spawnCalls[0].args;

    spawnCalls.length = 0;
    await runAgyPrint({ prompt: 'hi', bin: 'agy' });
    const withoutFlag = spawnCalls[0].args;

    assert.deepEqual(withFlag, withoutFlag);
  });

  it('usage/durationSeconds/agyConversationId/rawStdout are populated from the result event regardless of outputFormat', async () => {
    spawnCalls.length = 0;
    nextStdout = RESULT_LINE;
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'OK from fake agy\n');
    assert.equal(res.usage.total_tokens, 18379);
    assert.equal(res.durationSeconds, 1.73);
    assert.equal(res.agyConversationId, 'c-123');
    assert.ok(res.rawStdout.includes('"usage"'));
  });

  it('same result, no outputFormat passed at all: identical usage/duration/conversationId/rawStdout', async () => {
    spawnCalls.length = 0;
    nextStdout = RESULT_LINE;
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'hi', bin: 'agy' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'OK from fake agy\n');
    assert.equal(res.usage.total_tokens, 18379);
    assert.equal(res.durationSeconds, 1.73);
    assert.equal(res.agyConversationId, 'c-123');
    assert.ok(res.rawStdout.includes('"usage"'));
  });

  it('a stream with no result event: usage/duration/conversationId stay null, nothing is guessed', async () => {
    spawnCalls.length = 0;
    nextStdout = 'not a stream-json line at all\n';
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    assert.equal(res.status, 'failed');
    assert.match(res.stderr, /without a result event/);
    assert.equal(res.usage, null);
    assert.equal(res.durationSeconds, null);
    assert.equal(res.agyConversationId, null);
    assert.equal(res.rawStdout, 'not a stream-json line at all\n');
  });
});
