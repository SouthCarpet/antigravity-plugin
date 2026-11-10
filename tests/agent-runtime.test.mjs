import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgyArgs,
  runAgyPrint,
  DEFAULT_AGY_BIN,
  resolveAgyBin,
} from '../scripts/lib/agent-runtime.mjs';

describe('resolveAgyBin', () => {
  it('returns AGY_BIN env value when it points to an existing file', () => {
    const env = { AGY_BIN: process.execPath, PATH: '' };
    assert.equal(resolveAgyBin(env), process.execPath);
  });

  it('falls back to DEFAULT_AGY_BIN when nothing resolves', () => {
    const env = { PATH: '/nonexistent/dir', HOME: '/also/nonexistent' };
    assert.equal(resolveAgyBin(env), DEFAULT_AGY_BIN);
  });
});

// The stored-request contract treats models as data, including in workers.
describe('model values at the argv boundary', () => {
  for (const model of ['--dangerously-skip-permissions', '-x', '-', '  --x', '--x\nINJECTED']) {
    it(`refuses stored model ${JSON.stringify(model)} before any spawn`, async () => {
      await assert.rejects(runAgyPrint({ prompt: 'test', model, bin: 'missing-agy' }), {
        name: 'TypeError', message: 'runAgyPrint: model must not start with a dash',
      });
    });
  }
  it('keeps valid model punctuation in the full argv', () => {
    assert.deepEqual(buildAgyArgs({ mode: 'print', model: 'vendor/model-3.8:high', addDirs: [], extraArgs: [], timeoutMs: 300000 }), [
      '--model', 'vendor/model-3.8:high', '--print-timeout', '360s', '--disable-slash-commands',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '',
    ]);
  });
});
