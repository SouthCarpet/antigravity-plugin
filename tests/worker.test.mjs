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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

const TMPROOT = portableTmpRoot();

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
      runtime.options = options;
      await options.onSpawn?.({ pid: 7331 });
      options.onText?.('first delta');
      options.onText?.('second delta');
      return { ...runtime.next };
    },
    resolveAgyBin: () => 'agy',
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

const { ensureStateDir, upsertJob, writeJobFile, readJobFile } = await import('../scripts/lib/state.mjs');
const { buildSingleJobSnapshot } = await import('../scripts/lib/job-control.mjs');
const { renderSingleJobStatus } = await import('../scripts/lib/render.mjs');

describe('_worker.mjs background job completion', () => {
  for (const extraArgs of [undefined, [], ['--mode', 'plan'], ['--mode', 'accept-edits']]) {
    it('accepts stored ' + JSON.stringify(extraArgs) + ' and persists completion metadata', async () => {
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
        request: { prompt: 'hello', mode: 'print', addDirs: [], extraArgs },
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
        await import('../scripts/commands/_worker.mjs?args=' + encodeURIComponent(JSON.stringify(extraArgs)));
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
        removeTestDir(workspaceRoot);
        removeTestDir(dataDir);
      }

      assert.ok(stored, 'job file should exist after worker completion');
      assert.equal(stored.status, 'completed');
      assert.equal(stored.workerPid, process.pid);
      assert.equal(stored.agyPid, 7331);
      // R3: observed streamed output records all three activity timestamps.
      assert.ok(Number.isFinite(Date.parse(stored.lastProgressAt)));
      assert.ok(Number.isFinite(Date.parse(stored.lastModelOutputAt)));
      assert.ok(Number.isFinite(Date.parse(stored.lastHeartbeatAt)));
      assert.deepEqual(stored.result.usage, { total_tokens: 42, input_tokens: 10, output_tokens: 32 });
      assert.equal(stored.result.durationSeconds, 3.5);
      assert.equal(stored.result.agyConversationId, 'conv-123');
      // 076-T7 R1: stored counts after a worker finish (stdout is 'done', one line).
      assert.equal(stored.answerBytes, 4);
      assert.equal(stored.answerLines, 1);
      // Oracle: 076-T3 R1, legacy records get the full default budget.
      assert.equal(runtime.options.timeoutMs, 1800000);
    });
  }
});

// 076-T7 R3: a background task/rescue's stored request.model reaches agy the
// same way the foreground path does.
describe('_worker.mjs forwards a stored request.model to runAgyPrint (076-T7 R3)', () => {
  it('passes request.model through to runAgyPrint', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-model-'));
    const dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-model-data-'));
    const jobId = 'job' + randomBytes(3).toString('hex');

    const origCwd = process.cwd();
    const hadPluginDataEnv = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_PLUGIN_DATA');
    const origPluginData = process.env.CLAUDE_PLUGIN_DATA;
    const origArgv = process.argv;

    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    process.chdir(workspaceRoot);

    ensureStateDir(workspaceRoot);
    await upsertJob(workspaceRoot, {
      id: jobId, kind: 'task', status: 'queued', phase: 'queued',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await writeJobFile(workspaceRoot, jobId, {
      id: jobId, status: 'queued',
      request: { prompt: 'hello', mode: 'print', addDirs: [], model: 'gemini-x' },
      result: null,
    });

    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const exitMock = mock.method(process, 'exit', (code) => { resolveExit(code); });
    process.argv = [origArgv[0], origArgv[1], jobId];

    try {
      await import('../scripts/commands/_worker.mjs?args=' + encodeURIComponent('model-' + jobId));
      await exited;
    } finally {
      process.chdir(origCwd);
      process.argv = origArgv;
      if (hadPluginDataEnv) process.env.CLAUDE_PLUGIN_DATA = origPluginData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
      exitMock.mock.restore();
      removeTestDir(workspaceRoot);
      removeTestDir(dataDir);
    }

    assert.equal(runtime.options.model, 'gemini-x');
  });
});

describe('_worker.mjs auth_required stderr preservation (fix round 1 F3)', () => {
  it('stores agy stderr as errorMessage and status <id> renders a ## Error section', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-auth-'));
    const dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-auth-data-'));
    const jobId = 'job' + randomBytes(3).toString('hex');

    const origCwd = process.cwd();
    const hadPluginDataEnv = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_PLUGIN_DATA');
    const origPluginData = process.env.CLAUDE_PLUGIN_DATA;
    const origArgv = process.argv;
    const savedNext = { ...runtime.next };

    // A fake agy that hits auth_required by writing a stderr sentinel and
    // exiting normally (no timeout/output-limit termination), so
    // agent-runtime.mjs never populates `result.errorMessage` — the fallback
    // in _worker.mjs is the only path that can preserve this text.
    runtime.next = {
      status: 'auth_required',
      exitCode: 1,
      stdout: '',
      stderr: 'agy: token expired, please re-authenticate',
      errorMessage: undefined,
      oauthUrl: 'https://accounts.google.com/o/oauth2/auth?x',
      usage: null,
      durationSeconds: 1.2,
      agyConversationId: null,
    };

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
      request: { prompt: 'hello', mode: 'print', addDirs: [], extraArgs: [] },
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
    let rendered;
    try {
      await import('../scripts/commands/_worker.mjs?authcase=' + jobId);
      await exited;
      stored = readJobFile(workspaceRoot, jobId);
      // Render while CLAUDE_PLUGIN_DATA still points at the throwaway
      // dataDir — resolveStateRoot reads that env var.
      rendered = renderSingleJobStatus(buildSingleJobSnapshot(workspaceRoot, jobId));
    } finally {
      process.chdir(origCwd);
      process.argv = origArgv;
      if (hadPluginDataEnv) process.env.CLAUDE_PLUGIN_DATA = origPluginData;
      else delete process.env.CLAUDE_PLUGIN_DATA;
      exitMock.mock.restore();
      runtime.next = savedNext;
      removeTestDir(workspaceRoot);
      removeTestDir(dataDir);
    }

    assert.equal(stored.status, 'failed');
    assert.equal(stored.healthStatus, 'auth_required');
    assert.equal(stored.errorMessage, 'agy: token expired, please re-authenticate');
    assert.ok(rendered.includes('## Error'), 'expected a ## Error section');
    assert.ok(
      rendered.includes('agy: token expired, please re-authenticate'),
      'expected the preserved stderr text in the rendered status',
    );
  });
});

it('uses the stored 50 ms budget and persists failed after terminating a sleeping fake agy', () => {
  // Oracle: brief 076-T3 R1; the process seam avoids taskkill and verifies death.
  // The helper writes a real job store; its baseline is 5-6 s alone and grows
  // under a loaded full-suite run, so the bound is that order plus a safety
  // factor. Cleanup never throws past the assertions: a killed helper can
  // still hold a handle, and an EPERM here used to replace the real failure.
  const workspaceRoot = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-budget-'));
  const timeoutMs = 30000;
  let result;
  try {
    result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks',
      path.join(import.meta.dirname, 'helpers', 'runtime-budget.mjs'), 'worker',
    ], {
      cwd: workspaceRoot, encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(workspaceRoot, 'data') },
    });
  } finally {
    // The retrying helper can still throw on a handle a killed helper holds;
    // cleanup must never replace the assertions below.
    try { removeTestDir(workspaceRoot); } catch { /* temp dir */ }
  }
  assert.equal(result.error?.code, undefined,
    `helper did not finish within ${timeoutMs} ms: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
});

describe('worker persisted-request allowlist', () => {
  const cases = [
    { extraArgs: ['--dangerously-skip-permissions'], flag: '--dangerously-skip-permissions' },
    { extraArgs: ['--mode', 'yolo'], flag: '--mode' },
    { extraArgs: ['--mode'], flag: '--mode' },
    { extraArgs: ['--mode', 'plan', '--add-dir', 'C:/extra'], flag: '--add-dir' },
    { extraArgs: ['--mode', 'plan', '--mode', 'accept-edits'], flag: '--mode' },
    { extraArgs: '--dangerously-skip-permissions', flag: '--dangerously-skip-permissions' },
    { extraArgs: null, flag: 'null' },
    { extraArgs: {}, flag: '[object Object]' },
  ];
  for (const { extraArgs, flag } of cases) {
    it('fails stored ' + JSON.stringify(extraArgs) + ' before the owned process adapter spawns', () => {
      const workspace = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-reject-'));
      const data = path.join(workspace, 'data');
      const script = `
        import { mock } from 'node:test';
        const state = await import(${JSON.stringify(new URL('../scripts/lib/state.mjs', import.meta.url).href)});
        let spawns = 0;
        mock.module(${JSON.stringify(new URL('../scripts/lib/process-adapter.mjs', import.meta.url).href)}, {
          namedExports: { spawn() { spawns++; throw new Error('unexpected agy spawn'); } },
        });
        const workspace = process.cwd();
        const jobId = 'stored-request';
        state.ensureStateDir(workspace);
        await state.upsertJob(workspace, { id: jobId, kind: 'task', status: 'queued' });
        await state.writeJobFile(workspace, jobId, {
          id: jobId, kind: 'task', status: 'queued',
          request: { prompt: 'hello', extraArgs: ${JSON.stringify(extraArgs)} },
        });
        process.argv[2] = jobId;
        process.on('exit', () => {
          process.stdout.write(JSON.stringify({ spawns, stored: state.readJobFile(workspace, jobId) }));
        });
        await import(${JSON.stringify(new URL('../scripts/commands/_worker.mjs', import.meta.url).href)});
      `;
      try {
        const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '-e', script], {
          encoding: 'utf8', cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
        });
        assert.equal(result.status, 1, result.stderr);
        const { stored, spawns } = JSON.parse(result.stdout);
        assert.equal(spawns, 0);
        assert.equal(stored.status, 'failed');
        assert.equal(stored.healthStatus, 'failed');
        assert.equal(stored.errorMessage, 'stored request carries an unsupported agy flag: ' + flag);
      } finally { removeTestDir(workspace); }
    });
  }
});
