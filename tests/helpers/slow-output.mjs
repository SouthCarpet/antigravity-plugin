// Test-only preload and runner. Delays writes, preserves pipe properties and errors.
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.env.AGY_TEST_OUTPUT_REPORT) {
  const pending = { stdout: 0, stderr: 0 };
  for (const name of Object.keys(pending)) {
    const real = process[name];
    const slow = new Writable({
      write(chunk, encoding, callback) {
        setTimeout(() => real.write(chunk, encoding, callback), 25);
      },
    });
    // The write callback forwards descriptor errors to slow; consume the duplicate real-stream event.
    real.on('error', () => {});
    slow.isTTY = real.isTTY;
    slow.columns = real.columns;
    const write = slow.write.bind(slow);
    slow.write = (chunk, encoding, callback) => {
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
      pending[name]++;
      return write(chunk, encoding, error => { pending[name]--; callback?.(error); });
    };
    Object.defineProperty(process, name, { value: slow, configurable: true });
  }
  process.on('exit', code => fs.writeFileSync(process.env.AGY_TEST_OUTPUT_REPORT,
    JSON.stringify({ code, pending })));
}

export async function runOutput(args, directory, extraEnv = {}, slow = true, { closeStdout = false } = {}) {
  const report = path.join(directory, 'pending.json');
  fs.rmSync(report, { force: true });
  const env = { ...process.env, ...extraEnv, AGY_BIN: path.join(directory, 'missing-agy'),
    ANTIGRAVITY_NO_UPDATE_CHECK: '1' };
  delete env.AGY_TEST_OUTPUT_REPORT;
  if (slow) env.AGY_TEST_OUTPUT_REPORT = report;
  const preload = import.meta.url;
  const child = spawn(process.execPath, [...(slow ? ['--import', preload] : []), ...args],
    { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 20000 });
  const stdout = []; const stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  if (closeStdout) child.stdout.destroy();
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => signal ? reject(new Error(`child stopped: ${signal}`)) : resolve(code));
    });
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
      ...(slow ? { report: JSON.parse(fs.readFileSync(report, 'utf8')) } : {}) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export function assertDrained(result, entry) {
  const count = result.report.pending.stdout + result.report.pending.stderr;
  assert.equal(count, 0, `${entry}: pending writes at exit = ${count} (${JSON.stringify(result.report.pending)})`);
}
