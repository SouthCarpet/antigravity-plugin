/**
 * Smoke tests for the per-command modules.
 *
 * The tests mock `agent-runtime.runAgyPrint` and `child_process.spawn` so
 * that no real `agy` binary is invoked and no detached worker is spawned.
 * Each test runs against a fresh ANTIGRAVITY plugin-data directory.
 *
 * Strategy: we cannot ESM-monkey-patch the bound import of runAgyPrint
 * inside review/rescue/task once they are imported. Instead we drive the
 * happy-path through job-helpers directly and verify the state machine,
 * and we drive review/result/status/cancel through their `run()` entry
 * with carefully constructed jobs persisted on disk.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  upsertJob,
  writeJobFile,
  resolveJobLogFile,
  ensureStateDir,
  resolveJobFile,
} from '../scripts/lib/state.mjs';

const ORIGINAL_ENV = { ...process.env };

// Mocked once, at module top level, before rescue/review/task (or their
// shared job-helpers.mjs dependency) are ever imported below — mocks
// registered after a module has already been loaded do not retroactively
// apply (see the module doc comment above). The onText-mirroring tests near
// the bottom of this file rely on this.
const agyRuntime = {
  next: { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' },
  calls: [],
};
mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      agyRuntime.calls.push(opts);
      return { ...agyRuntime.next };
    },
    resolveAgyBin: () => 'agy',
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function makeTempCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
  // Make it look like a workspace root: an empty .git dir is enough for
  // git.mjs's ensureGitRepository(cwd) to return cwd itself when run by
  // resolveWorkspaceRoot. But ensureGitRepository runs `git rev-parse`, so
  // simpler: skip git and pass cwd directly.
  return dir;
}

function requireGit() {
  try {
    execSync('git --version', { stdio: 'ignore' });
  } catch {
    assert.fail(
      'git is required for this plugin: the review verb is built on it, and docs/COMPATIBILITY.md lists it as required. A missing git is a broken environment, not a skippable test.',
    );
  }
}

function initEmptyGitRepo(cwd) {
  requireGit();
  const env = { ...process.env, ...GIT_TEST_ENV };
  execSync('git init -q', { cwd, stdio: 'ignore', env });
  execSync('git commit --allow-empty -q -m init', { cwd, stdio: 'ignore', env });
  return env;
}

function setPluginDataEnv(dir) {
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'test-session-' + randomBytes(3).toString('hex');
}

function captureStdio({ pluginOnly = false } = {}) {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    // node:test reports its own binary V8-serializer frames on stdout while
    // a command yields; forward those untouched, never record them.
    if (typeof chunk !== 'string') return origStdout(chunk, ...rest);
    if (pluginOnly) {
      // While a command yields, node:test reports binary frames on stdout.
      // Forward those frames so the runner still receives every test result.
      try {
        const payload = JSON.parse(chunk.toString());
        if (payload?.schemaVersion !== 1 || typeof payload.command !== 'string') {
          return origStdout(chunk, ...rest);
        }
      } catch {
        return origStdout(chunk, ...rest);
      }
    }
    out.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    // Forward Node's asynchronous warnings; retain the plugin's diagnostics.
    if (pluginOnly && !chunk.toString().startsWith('antigravity:')) {
      return origStderr(chunk, ...rest);
    }
    err.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

function parseEnvelope(chunks, expected) {
  const payload = JSON.parse(chunks.join(''));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.command, expected.command);
  assert.equal(payload.status, expected.status);
  if (Object.hasOwn(expected, 'jobId')) assert.equal(payload.jobId, expected.jobId);
  else assert.ok(payload.jobId === null || typeof payload.jobId === 'string');
  if (Object.hasOwn(expected, 'answer')) assert.equal(payload.answer, expected.answer);
  else assert.ok(payload.answer === null || typeof payload.answer === 'string');
  assert.equal(typeof payload.details, 'object');
  assert.equal(Array.isArray(payload.details), false);
  return payload;
}

async function timedOutWaitContext(cwd) {
  const { createTrackedJob, waitForJob } = await import('../scripts/lib/job-helpers.mjs');
  return {
    cwd,
    startBackgroundJob: async (options) => ({
      job: await createTrackedJob(options),
      pid: null,
    }),
    waitForJob: async (workspaceRoot, jobId) => {
      let now = 0;
      return waitForJob(workspaceRoot, jobId, {
        timeoutMs: 50,
        now: () => now,
        sleep: async () => { now = 100; },
      });
    },
  };
}

let tempDir;
beforeEach(() => {
  tempDir = makeTempCwd();
  setPluginDataEnv(tempDir);
});
afterEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_ENV.CLAUDE_PLUGIN_DATA ?? '';
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

// ───────────────────────────── status ─────────────────────────────

describe('/antigravity:status', () => {
  it('--json wraps the all-jobs snapshot in the stable envelope', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'status', status: 'ok' });
    assert.deepEqual(payload.details.running, []);
  });

  it('renders an empty snapshot when no jobs exist', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /Antigravity Status/);
  });

  it('renders a single job snapshot when given a job id', async () => {
    const id = 'jobx' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      title: 'demo',
      status: 'completed',
      phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'hi' } });

    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, new RegExp(id));
    assert.match(text, /Antigravity Job/);
  });

  it('turns lock contention into a bounded friendly error', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], {
        cwd: tempDir,
        buildStatusSnapshot: () => {
          throw Object.assign(new Error('raw lock path'), { code: 'FILE_LOCK_TIMEOUT' });
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /busy.*try again/i);
    assert.doesNotMatch(cap.err.join(''), /raw lock path|\n\s+at /);
  });

  // Plan 085 T2: a single-job status view attaches the remedy for --json
  // and markdown, and the all-jobs list carries a lightweight count.
  it('single job --json carries details.job.deniedActions with a computed remedy', async () => {
    const id = 'jobd' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'rescue', status: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      deniedActions: [{ action: 'read_url', displayName: 'ReadUrlContent', source: 'json' }],
      deniedActionsCount: 1,
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'answer' } });

    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.deepEqual(payload.details.job.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', remedy: 'Headless runs cannot grant "read_url"; the host must run this step itself.' },
    ]);
  });

  it('single job markdown view renders a "## Denied Actions" section', async () => {
    const id = 'jobd' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      deniedActions: [{ action: 'write_to_file', displayName: null, source: 'stderr' }],
      deniedActionsCount: 1,
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'answer' } });

    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /## Denied Actions/);
    assert.match(text, /--mode accept-edits/);
  });

  it('the all-jobs list shows a per-job deniedActionsCount, not the full remedy array', async () => {
    const id = 'jobl' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      deniedActions: [{ action: 'read_url', displayName: null, source: 'json' }],
      deniedActionsCount: 1,
    });
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    const entry = payload.details.recent.find((j) => j.id === id);
    assert.equal(entry.deniedActionsCount, 1);
  });

  // Plan 086 T1: a single-job status view carries agy's print-timeout
  // marker under details.job.agyPrintTimeout, a "Note:" line in markdown,
  // and the all-jobs list carries the same field per job (a `Partial`
  // table marker in markdown).
  it('single job --json carries details.job.agyPrintTimeout', async () => {
    const id = 'jobp' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      agyPrintTimeout: { limit: '25s' },
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'partial answer' } });

    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.deepEqual(payload.details.job.agyPrintTimeout, { limit: '25s' });
  });

  it('single job markdown view renders a "Note:" line naming the print timeout', async () => {
    const id = 'jobp' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      agyPrintTimeout: { limit: '25s' },
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'partial answer' } });

    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /Note: the answer is partial\. agy's print timeout expired \(25s\)/);
  });

  it('the all-jobs list shows a per-job agyPrintTimeout, and the markdown table gets a Partial marker', async () => {
    const id = 'jobq' + randomBytes(2).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      agyPrintTimeout: { limit: '25s' },
    });
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run(['--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    const entry = payload.details.recent.find((j) => j.id === id);
    assert.deepEqual(entry.agyPrintTimeout, { limit: '25s' });

    const cap2 = captureStdio();
    let exit2;
    try { exit2 = await run([], { cwd: tempDir }); }
    finally { cap2.restore(); }
    assert.equal(exit2, 0);
    assert.match(cap2.out.join(''), new RegExp(`\\| ${id} \\|.*\\| partial \\|`));
  });
});

// ───────────────────────────── result ─────────────────────────────

describe('/antigravity:result', () => {
  // R2: unreadable details must never produce a success envelope.
  for (const [label, detail] of [
    ['missing', undefined], ['non-object', 'null'], ['array', '[]'],
    ['invalid JSON', '{ broken'],
    ['invalid record', '{"id":"123456abcdef","status":"completed","pid":0}'],
  ]) {
    for (const json of [false, true]) {
      it(`returns 1 and no stdout for ${label} detail${json ? ' under --json' : ''}`, async () => {
        const id = '123456abcdef';
        await upsertJob(tempDir, { id, status: 'completed' });
        if (detail !== undefined) fs.writeFileSync(resolveJobFile(tempDir, id), detail);
        const { run } = await import('../scripts/commands/result.mjs');
        const cap = captureStdio();
        let exit;
        try { exit = await run([id, ...(json ? ['--json'] : [])], { cwd: tempDir }); }
        finally { cap.restore(); }
        assert.equal(exit, 1);
        assert.equal(cap.out.join(''), '');
        assert.equal(cap.err.join(''), `antigravity:result — stored job ${id} is unreadable.\n`);
      });
    }
  }

  it('uses completed detail over a running index in status and result', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, status: 'running', sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'committed answer' } });
    const { buildStatusSnapshot, buildSingleJobSnapshot } = await import('../scripts/lib/job-control.mjs');
    assert.equal(buildSingleJobSnapshot(tempDir, id).job.status, 'completed');
    const snapshot = buildStatusSnapshot(tempDir);
    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.latestFinished.status, 'completed');
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'committed answer\n' });
  });

  // Plan 085 T2 item 4: `result` appends the denial section to the printed
  // markdown (never into the opaque `answer` field) and sets
  // `details.deniedActions` with the computed remedy on `--json`.
  it('carries deniedActions with remedy on --json and appends a markdown section', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, kind: 'rescue', status: 'completed' });
    await writeJobFile(tempDir, id, {
      id, kind: 'rescue', status: 'completed',
      result: {
        rawOutput: 'partial answer',
        deniedActions: [{ action: 'read_url', displayName: 'ReadUrlContent', source: 'json' }],
      },
    });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'partial answer\n' });
    assert.deepEqual(payload.details.deniedActions, [
      { action: 'read_url', displayName: 'ReadUrlContent', remedy: 'Headless runs cannot grant "read_url"; the host must run this step itself.' },
    ]);
  });

  it('carries no deniedActions key on --json for a clean run', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, kind: 'rescue', status: 'completed' });
    await writeJobFile(tempDir, id, { id, kind: 'rescue', status: 'completed', result: { rawOutput: 'clean' } });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'clean\n' });
    assert.equal(Object.hasOwn(payload.details, 'deniedActions'), false);
  });

  it('markdown output appends a "## Denied Actions" section after the answer, never inside --json answer', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, kind: 'task', status: 'completed' });
    await writeJobFile(tempDir, id, {
      id, kind: 'task', status: 'completed',
      result: {
        rawOutput: 'the answer',
        deniedActions: [{ action: 'write_to_file', displayName: null, source: 'stderr' }],
      },
    });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const text = cap.out.join('');
    assert.match(text, /the answer/);
    assert.match(text, /## Denied Actions/);
    assert.match(text, /--mode accept-edits/);
  });

  // Plan 086 T1: `result` surfaces agy's print-timeout marker as
  // `details.agyPrintTimeout` and a "Note:" markdown line, distinct from the
  // pre-existing `details.truncated` boolean (076-T7, `--head`/`--tail`
  // display cut) — the two must never collide.
  it('carries agyPrintTimeout on --json and appends a "Note:" markdown line', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, kind: 'task', status: 'completed' });
    await writeJobFile(tempDir, id, {
      id, kind: 'task', status: 'completed',
      result: { rawOutput: 'partial essay', agyPrintTimeout: { limit: '25s' } },
    });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'partial essay\n' });
    assert.deepEqual(payload.details.agyPrintTimeout, { limit: '25s' });
    assert.equal(Object.hasOwn(payload.details, 'truncated'), false);

    const cap2 = captureStdio();
    let exit2;
    try { exit2 = await run([id], { cwd: tempDir }); }
    finally { cap2.restore(); }
    assert.equal(exit2, 0);
    assert.match(cap2.out.join(''), /Note: the answer is partial\. agy's print timeout expired \(25s\)/);
  });

  it('carries no agyPrintTimeout key on --json for a clean run', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, kind: 'task', status: 'completed' });
    await writeJobFile(tempDir, id, { id, kind: 'task', status: 'completed', result: { rawOutput: 'clean' } });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'clean\n' });
    assert.equal(Object.hasOwn(payload.details, 'agyPrintTimeout'), false);
  });

  // The pre-existing 076-T7 `--head`/`--tail` `details.truncated` boolean
  // must keep working unchanged even on a job that also carries an
  // agyPrintTimeout marker — the two fields are independent (plan 086 T1).
  it('a job with both --head cutting and an agyPrintTimeout marker sets both details keys distinctly', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed', createdAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, {
      id, kind: 'task', status: 'completed',
      result: { rawOutput: 'one\ntwo\nthree\nfour\nfive', agyPrintTimeout: { limit: '25s' } },
    });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--head', '2', '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'one\ntwo' });
    assert.equal(payload.details.truncated, true);
    assert.deepEqual(payload.details.agyPrintTimeout, { limit: '25s' });
  });

  it('keeps the metadata fallback and exit 0 for a valid completed empty answer', async () => {
    const id = '123456abcdef';
    await upsertJob(tempDir, { id, status: 'completed' });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: '' } });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--json'], { cwd: tempDir }); }
    finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed' });
    assert.match(payload.answer, /Status: completed/);
    assert.equal(cap.err.join(''), '');
  });

  it('returns 1 with a friendly error when no jobs exist', async () => {
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /antigravity:result/);
  });

  it('turns lock contention into a bounded friendly error', async () => {
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], {
        cwd: tempDir,
        resolveResultJob: () => {
          throw Object.assign(new Error('raw lock path'), { code: 'FILE_LOCK_TIMEOUT' });
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /busy.*try again/i);
    assert.doesNotMatch(cap.err.join(''), /raw lock path|\n\s+at /);
  });

  it('renders a completed job and exits 0', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'completed',
      phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, {
      id,
      status: 'completed',
      result: { rawOutput: 'hello world from agy' },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /hello world from agy/);
  });

  it('--json wraps a completed result and its opaque answer', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'completed',
      phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, {
      id,
      status: 'completed',
      result: { rawOutput: 'opaque result text' },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    parseEnvelope(cap.out, {
      command: 'result',
      status: 'completed',
      jobId: id,
      answer: 'opaque result text\n',
    });
  });

  it('returns 2 for cancelled jobs', async () => {
    const id = 'ca11ce11ed00';
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'cancelled',
      phase: 'cancelled',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'cancelled' });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 2);
  });

  // 076-T7 fix round 1, F8: `result` on a `failed` job exits 1 by the same
  // `exitCodeForJobStatus` mapping every other terminal status goes through
  // (job-helpers.test.mjs pins the mapping itself); nothing pinned it for
  // `result` specifically before this. `status` is the one verb that does
  // NOT follow this pattern: it returns 0 on a failed job by frozen
  // contract (docs/COMMANDS.md, "`status` returns 0 whenever it
  // successfully produces a snapshot ... including ... when the observed
  // terminal status is failed") because producing the snapshot, not the
  // job's own outcome, is what `status` reports on.
  it('exits 1 for result on a failed job', async () => {
    const id = 'fa11edaaaaaa';
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'failed',
      phase: 'failed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'failed', errorMessage: 'boom' });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
  });

  it('prints a usage trailer on stderr when the stored job carries measured usage', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'completed',
      phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, {
      id,
      status: 'completed',
      result: {
        rawOutput: 'hello',
        usage: { total_tokens: 42, input_tokens: 10, output_tokens: 32 },
        durationSeconds: 3.5,
        agyConversationId: 'conv-123',
      },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    try {
      await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.match(cap.err.join(''), /usage: total=42 in=10 out=32/);
  });

  it('prints no usage trailer when the stored job has no usage', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'completed',
      phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, {
      id,
      status: 'completed',
      result: { rawOutput: 'hello', usage: null },
    });

    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    try {
      await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.doesNotMatch(cap.err.join(''), /usage: total=/);
  });

  // ─────────────────── 076-T7 R1: result --head/--tail ───────────────────

  async function resultWithFiveLineAnswer(extraArgs = []) {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed', phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'one\ntwo\nthree\nfour\nfive' } });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, ...extraArgs], { cwd: tempDir }); } finally { cap.restore(); }
    return { exit, out: cap.out.join(''), err: cap.err.join('') };
  }

  it('--head 2 shows the first two lines and the truncation note', async () => {
    const { exit, out } = await resultWithFiveLineAnswer(['--head', '2']);
    assert.equal(exit, 0);
    assert.equal(out, 'one\ntwo\n(showing 2 of 5 lines; full answer stored)\n');
  });

  it('--tail 1 shows only the last line', async () => {
    const { exit, out } = await resultWithFiveLineAnswer(['--tail', '1']);
    assert.equal(exit, 0);
    assert.equal(out, 'five\n(showing 1 of 5 lines; full answer stored)\n');
  });

  it('--head 2 --tail 1 shows the first two and the last one', async () => {
    const { exit, out } = await resultWithFiveLineAnswer(['--head', '2', '--tail', '1']);
    assert.equal(exit, 0);
    assert.equal(out, 'one\ntwo\nfive\n(showing 3 of 5 lines; full answer stored)\n');
  });

  it('--head 0 is rejected with the ArgsError shape', async () => {
    const { exit, out, err } = await resultWithFiveLineAnswer(['--head', '0']);
    assert.equal(exit, 1);
    assert.equal(out, '');
    assert.equal(err, 'antigravity:result — invalid value for --head: "0" (expected a positive integer)\n');
  });

  it('without --head/--tail the output is unchanged', async () => {
    const { exit, out } = await resultWithFiveLineAnswer([]);
    assert.equal(exit, 0);
    assert.equal(out, 'one\ntwo\nthree\nfour\nfive\n');
  });

  it('--head larger than the total line count is not truncated', async () => {
    const { exit, out } = await resultWithFiveLineAnswer(['--head', '99']);
    assert.equal(exit, 0);
    assert.equal(out, 'one\ntwo\nthree\nfour\nfive\n');
  });

  it('--json sets details.truncated and keeps answer as the cut text', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed', phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'one\ntwo\nthree\nfour\nfive' } });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--head', '2', '--json'], { cwd: tempDir }); } finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'one\ntwo' });
    assert.equal(payload.details.truncated, true);
  });

  // 076-T7 fix round 1, F9: the cut used to apply to `answer` but not to
  // `details.result.rawOutput`, so the --json path still carried the whole
  // stored answer even when truncated=true.
  it('--json cuts details.result.rawOutput too when truncated (F9)', async () => {
    const id = randomBytes(6).toString('hex');
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id, kind: 'task', status: 'completed', phase: 'completed',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'completed', result: { rawOutput: 'one\ntwo\nthree\nfour\nfive' } });
    const { run } = await import('../scripts/commands/result.mjs');
    const cap = captureStdio();
    let exit;
    try { exit = await run([id, '--head', '2', '--json'], { cwd: tempDir }); } finally { cap.restore(); }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'result', status: 'completed', answer: 'one\ntwo' });
    assert.equal(payload.details.truncated, true);
    assert.equal(payload.details.result.rawOutput, 'one\ntwo');
  });
});

// ───────────────────────────── cancel ─────────────────────────────

describe('/antigravity:cancel', () => {
  it('errors out when no active jobs exist', async () => {
    const { run } = await import('../scripts/commands/cancel.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /No active antigravity jobs/);
  });

  it('marks a running job cancelled when killed (with a fake pid)', async () => {
    const id = 'runningjob';
    ensureStateDir(tempDir);
    // Use a PID that is guaranteed not to exist; "not found" truthfully means
    // no work remains and is therefore a successful idempotent cancellation.
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'running',
      phase: 'running',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      pid: 2 ** 22,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'running', pid: 2 ** 22 });

    const { run } = await import('../scripts/commands/cancel.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id], {
        cwd: tempDir,
        terminateProcessTree: async (pid) => ({
          outcome: 'not_found', killed: true, pid, status: 128,
          attempts: [], message: `Process ${pid} is not running.`,
        }),
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /Antigravity Cancel/);
    assert.match(cap.out.join(''), new RegExp(`Cancelled ${id}`));
  });

  it('--json wraps a successful cancellation', async () => {
    const id = 'runningjsonjob';
    ensureStateDir(tempDir);
    await upsertJob(tempDir, {
      id,
      kind: 'task',
      status: 'running',
      phase: 'running',
      sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
      pid: 2 ** 22,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });
    await writeJobFile(tempDir, id, { id, status: 'running', pid: 2 ** 22 });

    const { run } = await import('../scripts/commands/cancel.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--json'], {
        cwd: tempDir,
        terminateProcessTree: async (pid) => ({
          outcome: 'not_found', killed: true, pid, status: 128,
          attempts: [], message: `Process ${pid} is not running.`,
        }),
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    parseEnvelope(cap.out, { command: 'cancel', status: 'cancelled', jobId: id });
  });
});

// ───────────────────────────── review ─────────────────────────────

describe('/antigravity:review', () => {
  it('--json emits an envelope when there are no changes', async () => {
    initEmptyGitRepo(tempDir);

    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }

    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, { command: 'review', status: 'no_changes' });
    assert.equal(typeof payload.details.scope, 'string');
  });

  it('--background --wait reports a queued timeout and keeps the queued JSON envelope', async () => {
    initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'pending-review.txt'), 'review me\n');
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['--background', '--wait', '--json'],
        await timedOutWaitContext(tempDir),
      );
    } finally {
      cap.restore();
    }

    assert.equal(exit, 1);
    const payload = parseEnvelope(cap.out, { command: 'review', status: 'queued' });
    assert.equal(
      cap.err.join(''),
      `antigravity:review — wait timed out; job ${payload.jobId} is still queued. Run /antigravity:status ${payload.jobId}.\n`,
    );
  });

  it('returns 0 with "no changes" when collectReviewContext finds nothing', async () => {
    // Empty git repo in tempDir so the working-tree diff is genuinely empty.
    initEmptyGitRepo(tempDir);

    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /no changes to review/i);
  });

  it('reviews an untracked-only working tree instead of reporting no changes', async () => {
    initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'brand-new.txt'), 'never committed\n');

    agyRuntime.calls = [];
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'review of new file', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }

    assert.equal(exit, 0);
    assert.doesNotMatch(cap.out.join(''), /no changes to review/i);
    const payload = parseEnvelope(cap.out, {
      command: 'review',
      status: 'completed',
      answer: 'review of new file',
    });
    assert.equal(payload.details.scope, 'working-tree');
    assert.equal(typeof payload.jobId, 'string');
    assert.ok(agyRuntime.calls.length >= 1, 'expected runAgyPrint to be invoked');
    assert.match(agyRuntime.calls[0].prompt, /brand-new\.txt/);
  });

  // Plan 086 T2 D1 item 3: review never exposes --effort, so it must never
  // gain the task/rescue default either.
  it('never sends an effort value to runAgyPrint (no --effort flag exists)', async () => {
    initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'brand-new-2.txt'), 'never committed\n');

    agyRuntime.calls = [];
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'review of new file', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.ok(agyRuntime.calls.length >= 1, 'expected runAgyPrint to be invoked');
    assert.equal(agyRuntime.calls[0].effort, undefined);
  });

  it('reviews a tracked-only working tree (no untracked files)', async () => {
    const gitEnv = initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'original\n');
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    execSync('git commit -q -m add', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'edited\n');

    agyRuntime.calls = [];
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'review of tracked edit', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }

    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, {
      command: 'review',
      status: 'completed',
      answer: 'review of tracked edit',
    });
    assert.equal(payload.details.scope, 'working-tree');
    assert.equal(typeof payload.jobId, 'string');
    assert.ok(agyRuntime.calls.length >= 1, 'expected runAgyPrint to be invoked');
    assert.match(agyRuntime.calls[0].prompt, /a\.txt/);
  });

  it('mirrors progress via onText (readable deltas), not raw NDJSON onStdout chunks', async () => {
    const gitEnv = initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'changed\n');
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    execSync('git commit -q -m change', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'changed again\n');

    agyRuntime.calls = [];
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'review answer', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    try {
      await run(['--json'], { cwd: tempDir });
      assert.equal(typeof agyRuntime.calls[0].onText, 'function');
      agyRuntime.calls[0].onText('a piece of readable text');
    } finally {
      cap.restore();
    }
    assert.match(cap.err.join(''), /a piece of readable text/);
    const payload = parseEnvelope(cap.out, {
      command: 'review',
      status: 'completed',
      answer: 'review answer',
    });
    assert.equal(typeof payload.jobId, 'string');
  });

  // Fix round 1 F7 verb-level case: a foreground `review` cancelled by agy
  // must exit 2 (docs/COMPATIBILITY.md exit codes), not `finishForeground`'s
  // generic 1. This exercises the shared line through a real verb, not just
  // a direct `finishForeground` call.
  it('exits 2 for a foreground review cancelled by agy', async () => {
    const gitEnv = initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'original\n');
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    execSync('git commit -q -m add', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'edited\n');

    agyRuntime.next = { status: 'cancelled', exitCode: 130, stdout: '', stderr: '' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 2);
  });
});

// ───────── 076-T7 R4: every verb exits non-zero when the job is failed ─────────
//
// Per verb, the test that pins a non-zero exit on a `failed` job status:
//   review  — 'exits 1 for a foreground review that agy reports failed' (below)
//   rescue  — already covered: tests/denial-verbs.test.mjs
//             'rescue: exit 1, names read_file, hints --add-dir <dir>' (foreground);
//             'exits 1 for a background rescue --wait that ends failed' (below, background)
//   task    — already covered: tests/denial-verbs.test.mjs
//             'task --foreground: exit 1, hints --add-dir <dir>' (foreground);
//             'exits 1 for a background task --wait that ends failed' (below, background)
//   vision  — already covered: tests/denial-verbs.test.mjs
//             'vision: exit 1, hints view_image and never --add-dir' (foreground only; no background mode)
//   result  — 'exits 1 for result on a failed job' (above, in the
//             /antigravity:result describe block, 076-T7 fix round 1 F8)
// `status` is the one verb that does NOT follow this pattern: it returns 0
// on a failed job by frozen contract (docs/COMMANDS.md) because it reports
// on whether it produced a snapshot, not on the job's own outcome.
// `finishForeground`/`exitCodeForJobStatus` (job-helpers.mjs) are the shared
// mapping every one of these goes through; job-helpers.test.mjs pins the
// mapping itself in isolation ('failed → status=failed and errorMessage from
// stderr', 'finishForeground returns exit code 2 for a cancelled result, 1
// for any other non-completed status').
describe('076-T7 R4: failed job status is always a non-zero exit', () => {
  it('exits 1 for a foreground review that agy reports failed', async () => {
    const gitEnv = initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'original\n');
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    execSync('git commit -q -m add', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'edited\n');

    agyRuntime.next = { status: 'failed', exitCode: 1, stdout: '', stderr: 'boom' };
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
  });

  it('exits 1 for a background rescue --wait that ends failed', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['help me', '--background', '--wait', '--json'], {
        cwd: tempDir,
        startBackgroundJob: async () => ({ job: { id: 'job-rescue-failed' } }),
        waitForJob: async () => ({ id: 'job-rescue-failed', status: 'failed' }),
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
  });

  it('exits 1 for a background task --wait that ends failed', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--wait', '--json'], {
        cwd: tempDir,
        startBackgroundJob: async () => ({ job: { id: 'job-task-failed' } }),
        waitForJob: async () => ({ id: 'job-task-failed', status: 'failed', result: null }),
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
  });

  it('exits 1 for a background review --wait that ends failed', async () => {
    initEmptyGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'pending-review.txt'), 'review me\n');
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--background', '--wait', '--json'], {
        cwd: tempDir,
        startBackgroundJob: async () => ({ job: { id: 'job-review-failed' } }),
        waitForJob: async () => ({ id: 'job-review-failed', status: 'failed' }),
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
  });
});

// ───────────────────────────── rescue + task argv parsing ─────────────────────────────

describe('/antigravity:rescue argv parsing', () => {
  it('--background --wait reports a queued timeout and keeps the queued JSON envelope', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['help me', '--background', '--wait', '--json'],
        await timedOutWaitContext(tempDir),
      );
    } finally {
      cap.restore();
    }

    assert.equal(exit, 1);
    const payload = parseEnvelope(cap.out, { command: 'rescue', status: 'queued' });
    assert.equal(
      cap.err.join(''),
      `antigravity:rescue — wait timed out; job ${payload.jobId} is still queued. Run /antigravity:status ${payload.jobId}.\n`,
    );
  });

  it('--json wraps the foreground model answer', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'rescue answer', stderr: '' };
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, {
      command: 'rescue',
      status: 'completed',
      answer: 'rescue answer',
    });
    assert.equal(typeof payload.jobId, 'string');
  });

  it('rejects empty prompt without --conversation', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /no task text/);
  });

  // 076-T7 R3: `agy --help` lists a global `--model` flag ("Model for the
  // current CLI session") honoured in print mode — the same flag `vision`
  // already forwards. `rescue` now stores and forwards it instead of
  // logging it as ignored.
  it('--model stores request.model and reaches agy via runAgyPrint (foreground)', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'rescue answer', stderr: '' };
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--model', 'gemini-x'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls[0].model, 'gemini-x');
    assert.doesNotMatch(cap.err.join(''), /Ignoring/);
  });

  it('mirrors progress via onText (readable deltas), not raw NDJSON onStdout chunks', async () => {
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    try {
      await run(['do the thing'], { cwd: tempDir });
      assert.equal(typeof agyRuntime.calls[0].onText, 'function');
      agyRuntime.calls[0].onText('a piece of readable text');
    } finally {
      cap.restore();
    }
    assert.match(cap.err.join(''), /a piece of readable text/);
  });

  // Plan 085 T3: `--effort` on `rescue`, additive, forwarded exactly as
  // `--model` already is.
  it('--effort stores request.effort and reaches agy via runAgyPrint (foreground)', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'rescue answer', stderr: '' };
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--effort', 'low'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls[0].effort, 'low');
  });

  // Plan 086 T2 D1: no --effort defaults to medium so a delegated run is
  // reproducible across machines; the explicit flag above still wins.
  it('no --effort defaults request.effort to medium (foreground)', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'rescue answer', stderr: '' };
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls[0].effort, 'medium');
  });

  it('no --effort on a background rescue stores request.effort medium', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    let capturedRequest;
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--background'], {
        cwd: tempDir,
        startBackgroundJob: async (options) => {
          capturedRequest = options.request;
          return { job: { id: 'job-rescue-default-effort', status: 'queued' } };
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(capturedRequest.effort, 'medium');
  });
});

describe('/antigravity:task argv parsing', () => {
  it('--wait reports a queued timeout and keeps the queued JSON envelope', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--wait', '--json'],
        await timedOutWaitContext(tempDir),
      );
    } finally {
      cap.restore();
    }

    assert.equal(exit, 1);
    const payload = parseEnvelope(cap.out, { command: 'task', status: 'queued' });
    assert.equal(
      cap.err.join(''),
      `antigravity:task — wait timed out; job ${payload.jobId} is still queued. Run /antigravity:status ${payload.jobId}.\n`,
    );
  });

  it('prints a worker launch failure and exits 1 with no queued JSON on PID-patch failure', async () => {
    // Oracle: 076-T3 R3 and the existing stderr-only failure contract.
    const { run } = await import('../scripts/commands/task.mjs');
    const { startBackgroundJob } = await import('../scripts/lib/job-helpers.mjs');
    let alive = true;
    const cap = captureStdio({ pluginOnly: true });
    let code;
    try {
      code = await run(['--json', 'do work'], {
        cwd: tempDir,
        startBackgroundJob: (options) => startBackgroundJob({
          ...options,
          spawnWorker: () => {
            const child = Object.assign(new EventEmitter(), { pid: 7331, unref() {} });
            setImmediate(() => child.emit('spawn'));
            return child;
          },
          persistWorkerPid: async () => { throw new Error('PID write failed'); },
          terminateTree: async () => { alive = false; },
        }),
      });
    } finally { cap.restore(); }
    assert.equal(code, 1);
    assert.equal(alive, false);
    assert.deepEqual(cap.out, []);
    assert.equal(cap.err.join(''), 'antigravity:task — failed: Worker launch failed: PID write failed\n');
  });
  it('--json wraps the foreground model answer', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'task answer', stderr: '' };
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--foreground', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = parseEnvelope(cap.out, {
      command: 'task',
      status: 'completed',
      answer: 'task answer',
    });
    assert.equal(typeof payload.jobId, 'string');
  });

  it('--wait --json emits one queued envelope and never appends raw model text', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--wait', '--json'], {
        cwd: tempDir,
        startBackgroundJob: async () => ({ job: { id: 'job-wait-json' } }),
        waitForJob: async () => ({
          status: 'completed',
          result: { rawOutput: 'this must not be appended' },
        }),
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    parseEnvelope(cap.out, {
      command: 'task',
      status: 'queued',
      jobId: 'job-wait-json',
    });
    assert.doesNotMatch(cap.out.join(''), /this must not be appended/);
  });

  it('rejects empty prompt without --conversation', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /no task text/);
  });

  // 076-T7 R3: task gains --model, additive, forwarded exactly as vision does.
  it('--model --foreground stores request.model and reaches agy', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'task answer', stderr: '' };
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--foreground', '--model', 'gemini-x'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls[0].model, 'gemini-x');
  });

  it('--model on a background task is stored in the job request', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    let capturedRequest;
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--model', 'gemini-x'], {
        cwd: tempDir,
        startBackgroundJob: async (options) => {
          capturedRequest = options.request;
          return { job: { id: 'job-model-test', status: 'queued' } };
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(capturedRequest.model, 'gemini-x');
  });

  // Plan 085 T3: `--effort` on `task`, additive, forwarded exactly as
  // `--model` already is.
  it('--effort --foreground stores request.effort and reaches agy', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'task answer', stderr: '' };
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--foreground', '--effort', 'high'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls[0].effort, 'high');
  });

  it('--effort on a background task is stored in the job request', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    let capturedRequest;
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--effort', 'medium'], {
        cwd: tempDir,
        startBackgroundJob: async (options) => {
          capturedRequest = options.request;
          return { job: { id: 'job-effort-test', status: 'queued' } };
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(capturedRequest.effort, 'medium');
  });

  // Plan 086 T2 D1: no --effort defaults to medium so a delegated run is
  // reproducible across machines; the explicit flag above still wins.
  it('no --effort defaults request.effort to medium (foreground)', async () => {
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'task answer', stderr: '' };
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--foreground'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls[0].effort, 'medium');
  });

  it('no --effort on a background task stores request.effort medium', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    let capturedRequest;
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing'], {
        cwd: tempDir,
        startBackgroundJob: async (options) => {
          capturedRequest = options.request;
          return { job: { id: 'job-default-effort-test', status: 'queued' } };
        },
      });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(capturedRequest.effort, 'medium');
  });

  it('mirrors progress via onText (readable deltas), not raw NDJSON onStdout chunks', async () => {
    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    try {
      await run(['do the thing', '--foreground'], { cwd: tempDir });
      assert.equal(typeof agyRuntime.calls[0].onText, 'function');
      agyRuntime.calls[0].onText('a piece of readable text');
    } finally {
      cap.restore();
    }
    assert.match(cap.err.join(''), /a piece of readable text/);
  });
});

// ───────────────────────────── job-helpers state machine ─────────────────────────────

describe('job-helpers.createTrackedJob', () => {
  it('creates a queued job index + per-job file', async () => {
    const { createTrackedJob } = await import('../scripts/lib/job-helpers.mjs');
    const job = await createTrackedJob({
      workspaceRoot: tempDir,
      kind: 'task',
      title: 'demo',
      request: { prompt: 'hello' },
    });
    assert.equal(job.kind, 'task');
    assert.equal(job.status, 'queued');
    assert.equal(typeof job.id, 'string');
    assert.ok(job.id.length > 0);

    const logPath = resolveJobLogFile(tempDir, job.id);
    assert.ok(fs.existsSync(logPath));
  });
});
