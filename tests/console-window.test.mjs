/**
 * Windows console behaviour of a background job (plan 153 package G).
 *
 * The background worker is detached and has no console. Before package G
 * every console program it started got a new console WINDOW, and Windows
 * handed that window to the default terminal application (one terminal
 * window per child). scripts/lib/process-adapter.mjs now starts every child
 * with `windowsHide: true`.
 *
 * Two cases, both with a real detached worker and the fake agy:
 *
 * 1. "no console window": the fake agy reports the console it got. This is
 *    the regression test. Without the hide option the report is `window=1`
 *    under every default-terminal setting, because the worker has no
 *    console to share.
 * 2. "no console host left behind": counts `conhost.exe` processes by
 *    parent PID and creation time once the job is finished. What it can
 *    detect: a console host of the worker or of agy that outlives the job.
 *    What it cannot detect: with Windows Console Host as the default
 *    terminal a console host ends with its program, with or without the
 *    hide option, so this case passed before package G too. It also cannot
 *    see a console host of a short helper (the start-time query, taskkill,
 *    git), because the job record does not store those PIDs.
 *
 * No real `agy` process is invoked.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { startBackgroundJob } from '../scripts/lib/job-helpers.mjs';
import { isProcessAlive } from '../scripts/lib/process.mjs';
import { readJobFile } from '../scripts/lib/state.mjs';
import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

const WINDOWS_ONLY = process.platform === 'win32'
  ? false
  : 'Windows only: a console window and conhost.exe exist on no other platform';
const TMPROOT = portableTmpRoot();
const cleanup = [];

after(() => {
  for (const dir of cleanup) removeTestDir(dir);
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

/**
 * Run one background job with a real worker and a fake agy to its end.
 * Returns the finished job record, the worker PID and the fake's console
 * report. The worker and the fake have both exited when this resolves.
 */
async function runBackgroundJobToEnd() {
  const workspaceRoot = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-console-work-'));
  const dataRoot = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-console-data-'));
  cleanup.push(workspaceRoot, dataRoot);
  const consoleReportFile = path.join(dataRoot, 'console-report.txt');
  const fakeAgy = writeFakeAgy(dataRoot, 'console-agy', {
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n',
    consoleReportFile,
  });
  const env = { ...process.env, AGY_BIN: fakeAgy, CLAUDE_PLUGIN_DATA: dataRoot, CODEX_PLUGIN_DATA: '', AGY_PLUGIN_DATA: '' };
  const savedData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataRoot;
  try {
    const startedAt = Date.now();
    const { job, pid } = await startBackgroundJob({ workspaceRoot, kind: 'task', title: 'console', prompt: 'say done', env });
    assert.ok(Number.isInteger(pid) && pid > 0, 'the worker started');
    const finished = await waitFor(() => {
      const record = readJobFile(workspaceRoot, job.id);
      return record && ['completed', 'failed', 'cancelled'].includes(record.status) ? record : null;
    }, 60_000);
    assert.ok(finished, 'the job reached a final status');
    assert.equal(finished.status, 'completed', finished.errorMessage ?? '');
    const bothGone = await waitFor(() => [pid, finished.agyPid].every((target) => !isProcessAlive(target)), 15_000);
    assert.ok(bothGone, 'the worker and the fake agy have exited');
    return { finished, workerPid: pid, startedAt, report: fs.readFileSync(consoleReportFile, 'utf8') };
  } finally {
    if (savedData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = savedData;
  }
}

/** `conhost.exe` processes created at or after `sinceMs` whose parent PID is in `parentPids`. */
function consoleHostsOf(parentPids, sinceMs) {
  const filter = parentPids.map((pid) => `ParentProcessId=${pid}`).join(' OR ');
  const command = `Get-CimInstance Win32_Process -Filter "Name='conhost.exe' AND (${filter})" | ` +
    'ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString(\'o\'))" }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, `the process query failed: ${result.stderr}`);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => { const [pid, parentPid, created] = line.split(' '); return { pid: Number(pid), parentPid: Number(parentPid), created }; })
    .filter((host) => Date.parse(host.created) >= sinceMs);
}

describe('background job consoles on Windows', { concurrency: false }, () => {
  it('starts agy with no console window', { skip: WINDOWS_ONLY }, async () => {
    const { report } = await runBackgroundJobToEnd();
    assert.equal(report, 'window=0 visible=0');
  });

  it('leaves no console host of the worker or of agy behind', { skip: WINDOWS_ONLY }, async () => {
    const { finished, workerPid, startedAt } = await runBackgroundJobToEnd();
    assert.ok(Number.isInteger(finished.agyPid) && finished.agyPid > 0, 'the job record holds the agy PID');
    // One second of margin: the OS creation time and Date.now() are read by different clocks.
    assert.deepEqual(consoleHostsOf([workerPid, finished.agyPid], startedAt - 1000), []);
  });
});
