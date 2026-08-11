/**
 * Tests for runAgyPrint's optional `outputFormat: 'json'` envelope parsing
 * (agy 1.1.x json envelope: { conversation_id, status, response,
 * duration_seconds, num_turns, usage:{...} } — shape probed live 2026-08-11).
 *
 * `node:child_process.spawn` is mocked the same way
 * tests/agent-runtime-vision.test.mjs mocks it (installed before
 * agent-runtime.mjs is imported) rather than shelling out to a real fake
 * binary: this repo's other real-spawn fixture (agent-runtime-deep.test.mjs)
 * hardcodes POSIX `/tmp` + `#!/bin/sh` stubs, which do not run on native
 * Windows. The mock lets us control exactly what stdout runAgyPrint sees,
 * which is what these assertions are actually about.
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
  return child;
}

mock.module('node:child_process', {
  namedExports: {
    spawn: (bin, args, opts) => {
      spawnCalls.push({ bin, args, opts });
      const child = makeFakeChild();
      setImmediate(() => {
        if (nextStdout) child.stdout.emit('data', nextStdout);
        child.emit('exit', nextExitCode);
      });
      return child;
    },
  },
});

const { runAgyPrint } = await import('../scripts/lib/agent-runtime.mjs');

// Real agy 1.1.x json envelope, probed live 2026-08-11 (measured token counts).
const ENVELOPE = JSON.stringify({
  conversation_id: 'c-123',
  status: 'SUCCESS',
  response: 'OK from fake agy\n',
  duration_seconds: 1.73,
  num_turns: 1,
  usage: {
    input_tokens: 18351, output_tokens: 28, thinking_tokens: 24,
    cache_read_tokens: 0, total_tokens: 18379,
  },
});

describe('runAgyPrint — outputFormat: json usage capture', () => {
  it('pushes --output-format json before --print', async () => {
    spawnCalls.length = 0;
    nextStdout = ENVELOPE;
    nextExitCode = 0;
    await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    const { args } = spawnCalls[0];
    const fmtIdx = args.indexOf('--output-format');
    const printIdx = args.indexOf('--print');
    assert.ok(fmtIdx > -1, 'expected --output-format in spawn args');
    assert.equal(args[fmtIdx + 1], 'json');
    assert.ok(fmtIdx < printIdx, '--output-format should precede --print');
  });

  it('envelope parsed, usage surfaced, stdout=response', async () => {
    spawnCalls.length = 0;
    nextStdout = ENVELOPE;
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'OK from fake agy\n');
    assert.equal(res.usage.total_tokens, 18379);
    assert.equal(res.durationSeconds, 1.73);
    assert.equal(res.agyConversationId, 'c-123');
    assert.ok(res.rawStdout.includes('"usage"'));
  });

  it('malformed envelope falls back to plain text, usage null', async () => {
    spawnCalls.length = 0;
    nextStdout = 'not json at all';
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'hi', bin: 'agy', outputFormat: 'json' });
    assert.equal(res.status, 'completed');
    assert.equal(res.stdout, 'not json at all');
    assert.equal(res.usage, null);
  });

  it('no outputFormat: behavior unchanged, no usage key pollution', async () => {
    spawnCalls.length = 0;
    nextStdout = 'plain text';
    nextExitCode = 0;
    const res = await runAgyPrint({ prompt: 'hi', bin: 'agy' });
    assert.equal(spawnCalls[0].args.includes('--output-format'), false);
    assert.equal(res.stdout, 'plain text');
    assert.equal(res.usage ?? null, null);
    assert.equal('rawStdout' in res, false);
  });
});
