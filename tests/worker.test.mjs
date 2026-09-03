/**
 * Tests for scripts/commands/_worker.mjs — Issue #2: background jobs must
 * persist measured usage (usage, durationSeconds, agyConversationId) into
 * the job record on completion, the same way runForegroundJob already does.
 *
 * _worker.mjs runs `main()` as a module-level side effect (it is designed to
 * be spawned as a standalone `node _worker.mjs <jobId>` child process) and
 * calls `process.exit()` when done. To exercise it in-process we mock
 * `process.exit` (so the test runner survives) and mock `runAgyPrint` via
 * node:test's experimental module mocking, following the pattern in
 * tests/job-helpers.test.mjs. The worker reads its jobId from
 * `process.argv[2]` and its workspace root from `process.cwd()`, so the test
 * temporarily chdirs into a throwaway workspace for its duration.
 *
 *   node --test --experimental-test-module-mocks tests/worker.test.mjs
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TMPROOT = os.tmpdir();

const runtime = {
  next: {
    status: 'completed',
    exitCode: 0,
    stdout: 'done',
    stderr: '',
    oauthUrl: undefined,
    usage: { total_tokens: 42, input_tokens: 10, output_tokens: 32 },
    durationSeconds: 3.5,
    agyConversationId: 'conv-123',
  },
};

mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (options) => {
      await options.onSpawn?.({ pid: 7331 });
      return { ...runtime.next };
    },
    spawnAgyDetached: () => ({ pid: 1 }),
    resolveAgyBin: () => 'agy',
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

const { ensureStateDir, upsertJob, writeJobFile, readJobFile } = await import('../scripts/lib/state.mjs');

describe('_worker.mjs background job completion', () => {
  it('persists usage, durationSeconds, and agyConversationId on the job record', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-'));
    const dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-data-'));
    const jobId = 'job' + randomBytes(3).toString('hex');

    const origCwd = process.cwd();
    const hadPluginDataEnv = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_PLUGIN_DATA');
    const origPluginData = process.env.CLAUDE_PLUGIN_DATA;
    const origArgv = process.argv;

    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    process.chdir(workspaceRoot);

    ensureStateDir(workspaceRoot);
    await upsertJob(workspaceRoot, {
      id: jobId,
      kind: 'task',
      status: 'queued',
      phase: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeJobFile(workspaceRoot, jobId, {
      id: jobId,
      status: 'queued',
      request: { prompt: 'hello', mode: 'print', addDirs: [] },
      result: null,
    });

    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const exitMock = mock.method(process, 'exit', (code) => {
      resolveExit(code);
    });
    process.argv = [origArgv[0], origArgv[1], jobId];

    let stored;
    try {
      await import('../scripts/commands/_worker.mjs');
      await exited;
      // Read back while CLAUDE_PLUGIN_DATA still points at the throwaway
      // dataDir — readJobFile resolves the state root from that env var.
      stored = readJobFile(workspaceRoot, jobId);
    } finally {
      process.chdir(origCwd);
      process.argv = origArgv;
      if (hadPluginDataEnv) process.env.CLAUDE_PLUGIN_DATA = origPluginData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
      exitMock.mock.restore();
    }

    assert.ok(stored, 'job file should exist after worker completion');
    assert.equal(stored.status, 'completed');
    assert.equal(stored.workerPid, process.pid);
    assert.equal(stored.agyPid, 7331);
    assert.deepEqual(stored.result.usage, { total_tokens: 42, input_tokens: 10, output_tokens: 32 });
    assert.equal(stored.result.durationSeconds, 3.5);
    assert.equal(stored.result.agyConversationId, 'conv-123');
  });
});
