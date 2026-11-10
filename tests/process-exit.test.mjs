// Oracle: package J requires pending stdout and stderr to finish before forced exit.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import processExit from '../scripts/lib/process-exit.cjs';
const { createProcessEnd } = processExit;
function slowStream() {
  let release;
  const stream = new Writable({ write(_chunk, _encoding, callback) { if (_chunk.length === 0) callback(); else release = callback; } });
  return { stream, finish(error) { release(error); } };
}
it('waits for 2 MB and both streams, reuses a second call, and keeps the first exit code', async () => {
  const out = slowStream(); const err = slowStream(); const codes = [];
  out.stream.write('x'.repeat(2 * 1024 * 1024)); err.stream.write('error');
  const end = createProcessEnd({ stdout: out.stream, stderr: err.stream, exitCode: 2, exit: code => codes.push(code) });
  const pending = end(); assert.equal(end(1), pending);
  await Promise.resolve(); assert.deepEqual(codes, []);
  out.finish(); await Promise.resolve(); assert.deepEqual(codes, []);
  err.finish(); await pending; assert.deepEqual(codes, [2]);
});
for (const code of ['EPIPE', 'EIO']) {
  it(`finishes without a stack or new exit code after ${code}`, async () => {
    const out = slowStream(); out.stream.write('pending'); const codes = [];
    const end = createProcessEnd({ stdout: out.stream, stderr: new Writable({ write(c,e,cb) { cb(); } }), exit: c => codes.push(c) });
    const pending = end(0); out.finish(Object.assign(new Error(code), { code }));
    await pending; assert.deepEqual(codes, [0]);
  });
}
it('ends from an async callback with the explicit code instead of the previous code', async () => {
  const codes = []; const stream = new Writable({ write(c,e,cb) { cb(); } });
  const end = createProcessEnd({ stdout: stream, stderr: stream, exitCode: 7, exit: c => codes.push(c) });
  await Promise.resolve().then(() => end(2)); assert.deepEqual(codes, [2]);
});
