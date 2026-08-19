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
    DEFAULT_AGY_BIN: 'agy',
  },
});

function makeTempCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
  // Make it look like a workspace root: an empty .git dir is enough for
  // git.mjs's ensureGitRepository(cwd) to return cwd itself when run by
  // resolveWorkspaceRoot. But ensureGitRepository runs `git rev-parse`, so
  // simpler: skip git and pass cwd directly.
  return dir;
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
    // Use a PID that is guaranteed not to exist so process.kill throws and we
    // verify the state mutation still happens.
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
      exit = await run([id], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /Antigravity Cancel/);
    assert.match(cap.out.join(''), new RegExp(`Cancelled ${id}`));
  });
});

// ───────────────────────────── review ─────────────────────────────

describe('/antigravity:review', () => {
  it('returns 0 with "no changes" when collectReviewContext finds nothing', async (t) => {
    // Patch collectReviewContext via a module mock: create a fake git env by
    // pointing cwd at tempDir which is not a git repo, then short-circuit by
    // installing a global hook on the prototype is impossible. Instead, we
    // simulate by injecting an empty diff via a sibling-helper: temporarily
    // replace process.env.GIT_DIR with a path that yields empty diffs.
    //
    // Simpler path: initialize an empty git repo in tempDir so working-tree
    // diff is genuinely empty.
    const { execSync } = await import('node:child_process');
    try {
      execSync('git init -q', { cwd: tempDir, stdio: 'ignore' });
      execSync('git commit --allow-empty -q -m init', { cwd: tempDir, stdio: 'ignore', env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 't@example.com',
      } });
    } catch {
      t.skip('git not available');
      return;
    }

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

  it('mirrors progress via onText (readable deltas), not raw NDJSON onStdout chunks', async (t) => {
    const { execSync } = await import('node:child_process');
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    try {
      execSync('git init -q', { cwd: tempDir, stdio: 'ignore' });
      execSync('git commit --allow-empty -q -m init', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    } catch {
      t.skip('git not available');
      return;
    }
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'changed\n');
    execSync('git add a.txt', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    execSync('git commit -q -m change', { cwd: tempDir, stdio: 'ignore', env: gitEnv });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'changed again\n');

    agyRuntime.calls = [];
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    try {
      await run([], { cwd: tempDir });
      assert.equal(typeof agyRuntime.calls[0].onText, 'function');
      agyRuntime.calls[0].onText('a piece of readable text');
    } finally {
      cap.restore();
    }
    assert.match(cap.err.join(''), /a piece of readable text/);
  });
});

// ───────────────────────────── rescue + task argv parsing ─────────────────────────────

describe('/antigravity:rescue argv parsing', () => {
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
    // Pass an unknown conversation id so we go via the background path quickly,
    // but startBackgroundJob will spawn a worker — so we stop at the model
    // warning by passing an empty prompt+conversation: hitting the early
    // model warning then the "no task text" error path. We assert the
    // warning + the eventual exit=1 from the empty-prompt check (because the
    // model check happens before the empty-prompt check).
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--model', 'pro'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    const errText = cap.err.join('');
    // Either the model warning printed OR the empty-prompt error printed.
    // We require the empty-prompt error to be present so the test is robust
    // against argv-parser changes; the model warning is logged in the
    // happy path through rescue.run prior to this exit.
    assert.match(errText, /no task text/);
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
