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

import {
  upsertJob,
  writeJobFile,
  appendJobLog,
  resolveJobLogFile,
  ensureStateDir,
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
    spawnAgyDetached: () => ({ pid: 1 }),
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

function captureStdio() {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    out.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
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
});

// ───────────────────────────── result ─────────────────────────────

describe('/antigravity:result', () => {
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
    const id = 'job' + randomBytes(3).toString('hex');
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
    const id = 'job' + randomBytes(3).toString('hex');
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
    const id = 'cancelledjob';
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

  it('prints a usage trailer on stderr when the stored job carries measured usage', async () => {
    const id = 'job' + randomBytes(3).toString('hex');
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
    const id = 'job' + randomBytes(3).toString('hex');
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
});

// ───────────────────────────── rescue + task argv parsing ─────────────────────────────

describe('/antigravity:rescue argv parsing', () => {
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

  it('logs an ignored-model warning when --model is passed', async () => {
    // The empty-prompt check runs before the --model check (see
    // scripts/commands/rescue.mjs), so a real prompt must be supplied for
    // this run to ever reach the warning at all.
    agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'rescue answer', stderr: '' };
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--model', 'pro'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(
      cap.err.join(''),
      /--model is accepted for forward-compatibility but agy 1\.0\.1 does not expose a per-invocation model flag yet\. Ignoring "pro"\./,
    );
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
});

describe('/antigravity:task argv parsing', () => {
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
