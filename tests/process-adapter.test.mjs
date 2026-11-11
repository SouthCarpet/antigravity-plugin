/**
 * Contract of scripts/lib/process-adapter.mjs.
 *
 * The adapter is the one place where a shipped file starts a process. It
 * sets `windowsHide: true` on every `spawn` and `spawnSync` call, so that a
 * child of the console-less background worker gets no console window on
 * Windows. `spawnInteractive` is the one named exception.
 *
 * `node:child_process` is replaced before the adapter loads, so no process
 * starts here. The oracle is the complete argument list that reaches Node.
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const calls = [];
const record = (fn) => (...args) => {
  calls.push({ fn, args });
  return { fn, marker: 'node result' };
};
mock.module('node:child_process', {
  namedExports: { ...realChildProcess, spawn: record('spawn'), spawnSync: record('spawnSync') },
});

const adapter = await import('../scripts/lib/process-adapter.mjs');

beforeEach(() => { calls.length = 0; });

describe('process-adapter: the hide option', () => {
  for (const fn of ['spawn', 'spawnSync']) {
    it(`${fn} adds windowsHide: true and keeps every caller option`, () => {
      const env = { A: '1' };
      const options = { cwd: 'C:\\work', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf8' };
      const result = adapter[fn]('agy', ['--print', 'x'], options);
      assert.deepEqual(calls, [{
        fn,
        args: ['agy', ['--print', 'x'], {
          cwd: 'C:\\work', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, encoding: 'utf8',
          windowsHide: true,
        }],
      }]);
      assert.equal(calls[0].args[2].env, env, 'the env object is passed on, not copied');
      assert.deepEqual(result, { fn, marker: 'node result' }, 'the result of Node is returned');
    });

    it(`${fn} does not change the caller's options object`, () => {
      const options = { stdio: ['pipe', 'pipe', 'pipe'] };
      adapter[fn]('git', ['status'], options);
      assert.deepEqual(options, { stdio: ['pipe', 'pipe', 'pipe'] });
    });

    it(`${fn} sets the option when the caller gives no options object`, () => {
      adapter[fn]('taskkill', ['/PID', '1']);
      assert.deepEqual(calls, [{ fn, args: ['taskkill', ['/PID', '1'], { windowsHide: true }] }]);
    });

    it(`${fn} sets the option when the caller gives neither arguments nor options`, () => {
      adapter[fn]('tar');
      assert.deepEqual(calls, [{ fn, args: ['tar', undefined, { windowsHide: true }] }]);
    });

    it(`${fn} keeps the meaning of the (command, options) form`, () => {
      adapter[fn]('tar', { cwd: 'C:\\x' });
      assert.deepEqual(calls, [{ fn, args: ['tar', [], { cwd: 'C:\\x', windowsHide: true }] }]);
    });

    for (const value of [false, undefined, 0, null]) {
      it(`${fn} does not let a caller switch the option off with windowsHide: ${value}`, () => {
        adapter[fn]('agy', ['--version'], { stdio: 'pipe', windowsHide: value });
        assert.deepEqual(calls, [{ fn, args: ['agy', ['--version'], { stdio: 'pipe', windowsHide: true }] }]);
      });
    }
  }
});

describe('process-adapter: spawnInteractive, the one exception', () => {
  it('passes the caller\'s arguments to Node unchanged, with no hide option', () => {
    const options = { stdio: ['inherit', 'inherit', 'inherit'], cwd: 'C:\\work', env: { A: '1' } };
    const result = adapter.spawnInteractive('agy', ['--print', 'x'], options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'spawn');
    assert.equal(calls[0].args[2], options, 'the same options object reaches Node');
    assert.deepEqual(calls[0].args, ['agy', ['--print', 'x'], { stdio: ['inherit', 'inherit', 'inherit'], cwd: 'C:\\work', env: { A: '1' } }]);
    assert.deepEqual(result, { fn: 'spawn', marker: 'node result' });
  });

  it('adds no options object when the caller gives none', () => {
    adapter.spawnInteractive('agy', ['--print', 'x']);
    assert.deepEqual(calls, [{ fn: 'spawn', args: ['agy', ['--print', 'x'], undefined] }]);
  });
});

// host-bootstrap.cjs is CommonJS and cannot load the adapter, so it sets the
// option itself. The oracle is its complete spawnSync call.
describe('host-bootstrap.cjs: the file that sets the hide option itself', () => {
  it('starts the verb with inherited stdio, the wrapper marker and windowsHide: true', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const { run } = createRequire(import.meta.url)('../scripts/lib/host-bootstrap.cjs');
    // The fake result has no status, which run() reports as exit code 1.
    assert.equal(run(root, 'status', ['--json']), 1);
    assert.deepEqual(calls, [{
      fn: 'spawnSync',
      args: [
        process.execPath,
        [path.join(root, 'scripts', 'commands', 'status.mjs'), '--json'],
        { stdio: 'inherit', windowsHide: true, env: { ...process.env, ANTIGRAVITY_HOST_WRAPPER: '1' } },
      ],
    }]);
  });
});

describe('process-adapter: exports', () => {
  it('exports exactly spawn, spawnSync and spawnInteractive', () => {
    assert.deepEqual(Object.keys(adapter).sort(), ['spawn', 'spawnInteractive', 'spawnSync']);
  });
});
