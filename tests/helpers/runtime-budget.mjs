// Integration fixture for brief 076-T3 R1: real runtime and persistence,
// with a two-second Node child behind the owned spawn adapter.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import * as processes from '../../scripts/lib/process.mjs';

const mode = process.argv[2];
let child;
let treeTerminated = false;
mock.module('../../scripts/lib/process-adapter.mjs', {
  namedExports: {
    spawn: (_command, _args, options) => {
      const script = mode === 'output-cap'
        ? "process.stdout.write('12345'); setTimeout(() => {}, 2000)"
        : 'setTimeout(() => {}, 2000)';
      // The sleeping fake agy runs outside the workspace on purpose: if this
      // helper is ever killed by its own launcher's timeout, the surviving
      // child must not hold the workspace directory open, or the caller's
      // cleanup fails with EPERM instead of reporting the real failure.
      child = spawn(process.execPath, ['-e', script], { ...options, cwd: os.tmpdir() });
      return child;
    },
  },
});
mock.module('../../scripts/lib/process.mjs', {
  namedExports: {
    ...processes,
    terminateProcessTree: async (pid, options) => {
      assert.equal(pid, child.pid);
      // Exercise the real bounded tree helper; use its signal adapter on
      // Windows too, since the sandbox bans taskkill. POSIX kills the group.
      await processes.terminateProcessTree(pid, { ...options, platform: 'linux' });
      assert.equal(processes.isProcessRunning(pid), false);
      treeTerminated = true;
    },
  },
});
const runtime = await import('../../scripts/lib/agent-runtime.mjs');
mock.module('../../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    ...runtime,
    runAgyPrint: (options) => runtime.runAgyPrint({
      ...options, bin: process.execPath,
      ...(mode === 'output-cap' ? { maxStdoutBytes: 4 } : {}),
    }),
  },
});
const { runForegroundJob, createTrackedJob } = await import('../../scripts/lib/job-helpers.mjs');
const { readJobFile } = await import('../../scripts/lib/state.mjs');
const workspaceRoot = process.cwd();

function verify(jobId) {
  const stored = readJobFile(workspaceRoot, jobId);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.healthStatus, 'failed');
  assert.equal(stored.errorMessage, mode === 'output-cap'
    ? 'agy output exceeded 4 bytes' : 'agy did not finish within 50 ms');
  assert.equal(stored.result.rawOutput, '');
  assert.equal(treeTerminated, true);
  assert.equal(processes.isProcessRunning(child.pid), false);
}

if (mode === 'worker') {
  const job = await createTrackedJob({
    workspaceRoot, kind: 'task', request: { prompt: 'p', timeoutMs: 50 },
  });
  // A different environment budget proves that the worker uses the record.
  process.env.ANTIGRAVITY_AGY_TIMEOUT_MS = '90000';
  process.argv[2] = job.id;
  mock.method(process, 'exit', (code) => {
    assert.equal(code, 1);
    verify(job.id);
    process.exitCode = 0;
  });
  await import('../../scripts/commands/_worker.mjs');
} else {
  const { job } = await runForegroundJob({
    workspaceRoot, kind: 'task', prompt: 'p',
    env: { ...process.env, ANTIGRAVITY_AGY_TIMEOUT_MS: mode === 'output-cap' ? '0' : '50' },
  });
  verify(job.id);
}
