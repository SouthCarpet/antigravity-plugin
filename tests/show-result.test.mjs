/**
 * `--show-result` after a background `--wait` (Task 7, "Senate R9",
 * 2026-09). `review`, `rescue`, and `task` share one background-wait tail
 * (`job-helpers.mjs#waitAndReport`), so this file drives all three through
 * their own `run()` entry with a fake `startBackgroundJob`/`waitForJob` pair
 * (the same dependency-injection seam `tests/commands.test.mjs`'s "076-T7
 * R4" describe block already uses for `failed`) rather than spawning a real
 * background worker or a fake `agy` binary: the flag's own logic lives
 * entirely in the shared tail, dispatch, and validation layers, none of
 * which touch the worker process.
 *
 * Four outcomes per verb: `completed`, `failed`, `cancelled`, and a wait
 * that times out while the job is still `queued`/`running`. Each is checked
 * in both `--json` (exactly one parsed envelope, exact exit code) and text
 * mode (exact stdout/stderr shape). A same-fixture with/without-flag pair
 * per verb pins that leaving the flag off is unchanged from before this
 * task.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { captureStdio } from './helpers/capture-stdio.mjs';

mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async () => {
      throw new Error('runAgyPrint must not be called: startBackgroundJob/waitForJob are overridden');
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-show-result-'));
}

function initEmptyGitRepo(cwd) {
  const env = { ...process.env, ...GIT_TEST_ENV };
  execSync('git init -q', { cwd, stdio: 'ignore', env });
  execSync('git commit --allow-empty -q -m init', { cwd, stdio: 'ignore', env });
  return env;
}

function setPluginDataEnv(dir) {
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'test-session-' + randomBytes(3).toString('hex');
}

/** A queued job {@link startBackgroundJob} hands back, never `failed`, so
 * `reportQueuedJob` always takes its success branch in these tests. */
function queuedJob(id) {
  return { job: { id, status: 'queued' } };
}

function baseJob(kind, id, status, overrides = {}) {
  return {
    id,
    kind,
    status,
    conversationId: null,
    provenance: {
      pluginVersion: 'test', agyVersion: 'test', model: null, effort: null,
      mode: 'print', addDirCount: 0, requestedAt: '2026-01-01T00:00:00.000Z',
    },
    request: {},
    ...overrides,
  };
}

function completedJob(kind, id, overrides = {}) {
  return baseJob(kind, id, 'completed', {
    result: {
      rawOutput: 'the finished answer', stderr: '', status: 'completed', exitCode: 0, oauthUrl: null,
      usage: { total_tokens: 42, input_tokens: 30, output_tokens: 12 }, durationSeconds: 3.2,
      agyConversationId: 'agy-conv-1', warnings: [], deniedActions: null, agyPrintTimeout: null,
      reportedModel: null,
    },
    ...overrides,
  });
}

function failedJob(kind, id, overrides = {}) {
  return baseJob(kind, id, 'failed', {
    errorMessage: 'agy exited 1: boom', healthMessage: null,
    result: { rawOutput: '', stderr: 'boom', status: 'failed', exitCode: 1, deniedActions: null },
    ...overrides,
  });
}

function cancelledJob(kind, id, overrides = {}) {
  return baseJob(kind, id, 'cancelled', {
    result: { rawOutput: '', stderr: '', status: 'cancelled', exitCode: 130, deniedActions: null },
    ...overrides,
  });
}

function pendingJob(kind, id, status) {
  return baseJob(kind, id, status, { result: null });
}

let tempDir;
beforeEach(() => {
  tempDir = makeTempCwd();
  setPluginDataEnv(tempDir);
});
afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

/**
 * Per-verb fixture: the module, the argv prefix that reaches the background
 * path (before `--wait`/`--show-result`/`--json` are appended), and any
 * setup the verb needs before `run()` (review needs reviewable content).
 */
const VERB_FIXTURES = {
  task: {
    modulePath: '../scripts/commands/task.mjs',
    baseArgv: ['do the thing', '--background'],
    setup: () => {},
  },
  rescue: {
    modulePath: '../scripts/commands/rescue.mjs',
    baseArgv: ['help me', '--background'],
    setup: () => {},
  },
  review: {
    modulePath: '../scripts/commands/review.mjs',
    baseArgv: ['--background'],
    setup: (cwd) => {
      initEmptyGitRepo(cwd);
      fs.writeFileSync(path.join(cwd, 'pending-review.txt'), 'review me\n');
    },
  },
};

for (const [kind, fixture] of Object.entries(VERB_FIXTURES)) {
  describe(`/antigravity:${kind} --show-result (Task 7, "Senate R9")`, () => {
    async function runVerb(argv, ctx) {
      fixture.setup(tempDir);
      const { run } = await import(fixture.modulePath);
      return run([...fixture.baseArgv, ...argv], { cwd: tempDir, ...ctx });
    }

    it('completed --json: one envelope with the answer and details, exit 0', async () => {
      const job = completedJob(kind, `${kind}-ok`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result', '--json'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 0);
      assert.equal(cap.out.length, 1, 'exactly one stdout write');
      const payload = JSON.parse(cap.out.join(''));
      assert.equal(payload.schemaVersion, 1);
      assert.equal(payload.command, kind);
      assert.equal(payload.status, 'completed');
      assert.equal(payload.jobId, job.id);
      assert.equal(payload.answer, 'the finished answer');
      assert.equal(payload.details.conversationId, null);
      assert.equal(payload.details.agyConversationId, 'agy-conv-1');
      assert.deepEqual(payload.details.provenance, job.provenance);
      assert.equal(payload.details.result.usage.total_tokens, 42);
      assert.equal(payload.details.result.durationSeconds, 3.2);
      // Dispatch-time stdout stayed empty and the queued notice moved to
      // stderr, in JSON mode too.
      assert.equal(cap.err.join(''), `Background ${kind} started: ${job.id}\nusage: total=42 in=30 out=12\n`);
    });

    it('completed text mode: rawOutput on stdout, usage trailer on stderr, exit 0', async () => {
      const job = completedJob(kind, `${kind}-ok-text`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 0);
      assert.equal(cap.out.join(''), 'the finished answer');
      assert.equal(cap.err.join(''), `Background ${kind} started: ${job.id}\nusage: total=42 in=30 out=12\n`);
    });

    it('failed --json: job_failed error envelope, exit 1', async () => {
      const job = failedJob(kind, `${kind}-failed`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result', '--json'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 1);
      assert.equal(cap.out.length, 1);
      const payload = JSON.parse(cap.out.join(''));
      assert.equal(payload.status, 'failed');
      assert.equal(payload.jobId, job.id);
      assert.equal(payload.answer, null);
      assert.equal(payload.details.error.code, 'job_failed');
      assert.equal(payload.details.error.phase, 'run');
      assert.equal(payload.details.error.message, 'agy exited 1: boom');
      assert.equal(cap.err.join(''), `Background ${kind} started: ${job.id}\n`);
    });

    it('failed text mode: errorMessage on stderr, nothing on stdout, exit 1', async () => {
      const job = failedJob(kind, `${kind}-failed-text`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 1);
      assert.equal(cap.out.join(''), '');
      assert.equal(
        cap.err.join(''),
        `Background ${kind} started: ${job.id}\nantigravity:${kind} — agy exited 1: boom\n`,
      );
    });

    it('cancelled --json: job_cancelled error envelope, exit 2', async () => {
      const job = cancelledJob(kind, `${kind}-cancelled`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result', '--json'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 2);
      assert.equal(cap.out.length, 1);
      const payload = JSON.parse(cap.out.join(''));
      assert.equal(payload.status, 'cancelled');
      assert.equal(payload.jobId, job.id);
      assert.equal(payload.answer, null);
      assert.equal(payload.details.error.code, 'job_cancelled');
      assert.equal(payload.details.error.phase, 'run');
    });

    it('cancelled text mode: nothing on stdout beyond the queued notice, exit 2', async () => {
      const job = cancelledJob(kind, `${kind}-cancelled-text`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 2);
      assert.equal(cap.out.join(''), '');
      assert.equal(cap.err.join(''), `Background ${kind} started: ${job.id}\n`);
    });

    it('wait timeout --json: wait_timeout error envelope, never reports completion, exit 1', async () => {
      const job = pendingJob(kind, `${kind}-pending`, 'running');
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result', '--json'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 1);
      assert.equal(cap.out.length, 1);
      const payload = JSON.parse(cap.out.join(''));
      assert.equal(payload.status, 'running');
      assert.equal(payload.jobId, job.id);
      assert.equal(payload.answer, null);
      assert.equal(payload.details.error.code, 'wait_timeout');
      assert.equal(payload.details.error.phase, 'wait');
      assert.match(payload.details.error.message, /still running/);
    });

    it('wait timeout text mode: the existing "wait timed out" line, nothing on stdout, exit 1', async () => {
      const job = pendingJob(kind, `${kind}-pending-text`, 'queued');
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--show-result'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 1);
      assert.equal(cap.out.join(''), '');
      assert.equal(
        cap.err.join(''),
        `Background ${kind} started: ${job.id}\n` +
          `antigravity:${kind} — wait timed out; job ${job.id} is still queued. Run /antigravity:status ${job.id}.\n`,
      );
    });

    it('without --show-result the completed --wait --json output is unchanged (byte-parity)', async () => {
      const job = completedJob(kind, `${kind}-no-flag`);
      const cap = captureStdio();
      let exit;
      try {
        exit = await runVerb(['--wait', '--json'], {
          startBackgroundJob: async () => queuedJob(job.id),
          waitForJob: async () => job,
        });
      } finally {
        cap.restore();
      }
      assert.equal(exit, 0);
      // Legacy contract (docs/COMPATIBILITY.md): the queued envelope is
      // retained on stdout; the completed job's own answer is never
      // appended, except task's own pre-existing exception below.
      const payload = JSON.parse(cap.out.join(''));
      assert.equal(payload.status, 'queued');
      assert.equal(payload.jobId, job.id);
      if (kind === 'task') {
        // task --wait (no --json-gated raw-output rule): the completed
        // job's rawOutput still is not appended under --json.
        assert.equal(cap.out.join('').trim().endsWith('}'), true);
      }
      assert.equal(cap.err.join(''), 'usage: total=42 in=30 out=12\n');
    });
  });
}

describe('--show-result flag validation (Task 7, "Senate R9")', () => {
  it('task: --show-result without --wait is refused, stderr-only, exit 1, no --json envelope', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--show-result', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:task — --show-result requires --wait\n');
  });

  it('task: --show-result --foreground --wait is refused the same way (foreground has no wait)', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--show-result', '--foreground', '--wait'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:task — --show-result requires --wait\n');
  });

  it('rescue: --show-result --wait without --background is refused', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['help me', '--show-result', '--wait'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:rescue — --show-result requires --background\n');
  });

  it('rescue: --show-result without --wait is refused before the --background check', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['help me', '--show-result', '--background', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:rescue — --show-result requires --wait\n');
  });

  it('review: --show-result --wait without --background is refused, before any git collection', async () => {
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--show-result', '--wait'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:review — --show-result requires --background\n');
  });
});
