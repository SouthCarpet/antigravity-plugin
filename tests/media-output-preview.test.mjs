/**
 * `media --preview` with `--output` and `--timestamps` (3.2.0).
 * The preview keeps its guarantee: no agy spawn, no download, no state write,
 * no file write. It uses the real runtime (the preview builds its argv with
 * it), so this file does not mock the agent runtime.
 *
 *   node --test --experimental-test-module-mocks tests/media-output-preview.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStdio } from './helpers/capture-stdio.mjs';
import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { run } from '../scripts/commands/media.mjs';

const URL = 'https://youtu.be/jNQXAC9IVRw';
const saved = { path: process.env.PATH, data: process.env.CLAUDE_PLUGIN_DATA, bin: process.env.AGY_BIN };
let dir;
let touch;
let wav;

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'media-output-preview-')));
  touch = path.join(dir, 'agy-was-spawned');
  process.env.AGY_BIN = writeFakeAgy(dir, 'agy', { versionOk: true, touchFile: touch });
  process.env.CLAUDE_PLUGIN_DATA = path.join(dir, 'data');
  process.env.PATH = '';
  wav = path.join(dir, 'speech.wav');
  fs.writeFileSync(wav, 'audio');
});
afterEach(() => {
  process.env.PATH = saved.path;
  for (const [key, value] of [['CLAUDE_PLUGIN_DATA', saved.data], ['AGY_BIN', saved.bin]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function go(args) {
  const cap = captureStdio();
  let code;
  try {
    code = await run(args, { cwd: dir });
  } finally {
    cap.restore();
  }
  return { code, out: cap.out.join(''), err: cap.err.join('') };
}

const nothingHappened = () => {
  assert.equal(fs.existsSync(touch), false, 'agy was spawned');
  assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'state was written');
};

// Oracle: the preview shows the facts, validates the shape, writes nothing.
test('shows the resolved target and the timestamps fact and writes nothing', async () => {
  const r = await go([URL, '--transcript', '--timestamps', '--output', 'p.txt', '--preview', '--json']);
  assert.equal(r.code, 0, r.err);
  const { details } = JSON.parse(r.out);
  assert.equal(details.output, path.join(dir, 'p.txt'));
  assert.equal(details.timestamps, true);
  assert.equal(details.mode, 'transcript');
  assert.equal(details.agyCall, false);
  assert.equal(fs.existsSync(path.join(dir, 'p.txt')), false);
  nothingHappened();
});

test('the text preview shows the same facts', async () => {
  const r = await go([wav, '--output', 'p.txt', '--preview']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`"output": ${JSON.stringify(path.join(dir, 'p.txt')).replace(/\\/g, '\\\\')}`));
  nothingHappened();
});

test('without the flags the preview has neither key', async () => {
  const { details } = JSON.parse((await go([wav, '--preview', '--json'])).out);
  assert.equal('output' in details, false);
  assert.equal('timestamps' in details, false);
});

test('checks the shape of the value only: an existing file is shown, not refused, and stays unchanged', async () => {
  fs.writeFileSync(path.join(dir, 'exists.txt'), 'original');
  const r = await go([wav, '--output', 'exists.txt', '--preview', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).details.output, path.join(dir, 'exists.txt'));
  assert.equal(fs.readFileSync(path.join(dir, 'exists.txt'), 'utf8'), 'original');
});

test('refuses a control character and an empty value with the output code', async () => {
  for (const value of ['a\nb.txt', '']) {
    const r = await go([wav, '--output', value, '--preview', '--json']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).details.error.code, 'output_target_unwritable');
  }
  nothingHappened();
});

test('--timestamps without --transcript is refused in the preview too', async () => {
  const r = await go([URL, '--timestamps', '--preview']);
  assert.equal(r.code, 1);
  assert.equal(r.err, 'antigravity:media — --timestamps requires --transcript\n');
});
