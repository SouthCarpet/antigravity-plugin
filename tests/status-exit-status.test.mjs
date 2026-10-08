/**
 * `--exit-status` on `status <id> --wait` (Task 8, "Senate R10", 2026-09).
 *
 * Opt-in: without the flag, `status --wait` keeps its frozen contract of
 * returning 0 whenever it successfully produces a snapshot, including a
 * failed/cancelled/still-running observed job (docs/COMMANDS.md). With the
 * flag, a terminal job's own outcome decides the exit code
 * (`exitCodeForJobStatus`: 0 completed, 1 failed, 2 cancelled) and a wait
 * deadline that passes while the job is still `queued`/`running` exits 3
 * with one new stderr line. Markdown and `--json` output are unchanged in
 * every case; only the exit code (and, for the timeout outcome, one stderr
 * line) differs. `status` has no reason to require a real `agy` binary or
 * background worker for any of this, so every fixture here is a
 * pre-written job (index entry + job file), the same pattern
 * `tests/commands.test.mjs`'s `/antigravity:status` and `/antigravity:result`
 * describe blocks already use, per `tests/job-control.test.mjs` and
 * `tests/show-result.test.mjs`.
 *
 * The `queued`/`running` fixtures never reach a terminal state on their
 * own, so exercising the real timeout path costs one real `POLL_MS` sleep
 * (status.mjs's own wait loop has no injectable clock) per such case.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { ensureStateDir, upsertJob, writeJobFile } from '../scripts/lib/state.mjs';

function makeTempCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-exit-status-'));
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
    if (typeof chunk !== 'string') return origStdout(chunk, ...rest);
    out.push(chunk);
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return origStderr(chunk, ...rest);
    err.push(chunk);
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

/** A pre-written job: index entry (`upsertJob`) + job file (`writeJobFile`),
 * the exact pair `tests/commands.test.mjs`'s status/result fixtures use. */
async function makeJob(cwd, id, status, fileExtra = {}) {
  ensureStateDir(cwd);
  const now = new Date().toISOString();
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  await upsertJob(cwd, {
    id,
    kind: 'task',
    title: 'demo',
    status,
    phase: status,
    sessionId: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID,
    createdAt: now,
    updatedAt: now,
    ...(terminal ? { completedAt: now } : {}),
  });
  await writeJobFile(cwd, id, { id, status, ...fileExtra });
}

/** Strip the real-clock "Elapsed" text (markdown and `--json` alike) before
 * a byte-parity comparison across two sequential `--wait` calls on a
 * still-`queued`/`running` job: each call's own real `POLL_MS` sleep moves
 * the wall clock, so the two calls' own elapsed text legitimately differs
 * even though the flag changes nothing about how it is rendered. */
function stripElapsed(text) {
  return text
    .replace(/- \*\*Elapsed:\*\* \d+s\n/, '- **Elapsed:** Ns\n')
    .replace(/"elapsed": "\d+s"/, '"elapsed": "Ns"');
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

describe('--exit-status flag validation (Task 8, "Senate R10", 2026-09)', () => {
  it('refused without a job id: stderr only, exit 1, no stdout', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--exit-status', '--wait'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:status — --exit-status requires a job id and --wait\n');
  });

  it('refused without --wait: stderr only, exit 1, no stdout', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['some-job-id', '--exit-status'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:status — --exit-status requires a job id and --wait\n');
  });

  it('refused with neither a job id nor --wait', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--exit-status'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:status — --exit-status requires a job id and --wait\n');
  });

  it('refused under --json too: no envelope reaches stdout', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--exit-status', '--wait', '--json'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.equal(cap.err.join(''), 'antigravity:status — --exit-status requires a job id and --wait\n');
  });

  it('the all-jobs list (no reference, no --wait) is unaffected by the flag being absent', async () => {
    const { run } = await import('../scripts/commands/status.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
  });
});

describe('/antigravity:status <id> --wait --exit-status (Task 8, "Senate R10", 2026-09)', () => {
  it('completed: exit 0 with the flag, exit 0 without, markdown output unchanged', async () => {
    const id = 'e00000000001';
    await makeJob(tempDir, id, 'completed', { result: { rawOutput: 'hi' } });
    const { run } = await import('../scripts/commands/status.mjs');

    const capFlag = captureStdio();
    let exitFlag;
    try {
      exitFlag = await run([id, '--wait', '--exit-status'], { cwd: tempDir });
    } finally {
      capFlag.restore();
    }
    const capPlain = captureStdio();
    let exitPlain;
    try {
      exitPlain = await run([id, '--wait'], { cwd: tempDir });
    } finally {
      capPlain.restore();
    }

    assert.equal(exitFlag, 0);
    assert.equal(exitPlain, 0);
    assert.equal(capFlag.out.join(''), capPlain.out.join(''));
    assert.equal(capFlag.err.join(''), '');
    assert.equal(capPlain.err.join(''), '');
  });

  it('completed --json: exit 0 with the flag, exit 0 without, envelope unchanged', async () => {
    const id = 'e00000000002';
    await makeJob(tempDir, id, 'completed', { result: { rawOutput: 'hi' } });
    const { run } = await import('../scripts/commands/status.mjs');

    const capFlag = captureStdio();
    let exitFlag;
    try {
      exitFlag = await run([id, '--wait', '--exit-status', '--json'], { cwd: tempDir });
    } finally {
      capFlag.restore();
    }
    const capPlain = captureStdio();
    let exitPlain;
    try {
      exitPlain = await run([id, '--wait', '--json'], { cwd: tempDir });
    } finally {
      capPlain.restore();
    }

    assert.equal(exitFlag, 0);
    assert.equal(exitPlain, 0);
    assert.equal(capFlag.out.join(''), capPlain.out.join(''));
    const payload = JSON.parse(capFlag.out.join(''));
    assert.equal(payload.status, 'completed');
    assert.equal(payload.jobId, id);
  });

  it('failed: exit 1 with the flag, exit 0 without, output unchanged', async () => {
    const id = 'e00000000003';
    await makeJob(tempDir, id, 'failed', { errorMessage: 'boom' });
    const { run } = await import('../scripts/commands/status.mjs');

    const capFlag = captureStdio();
    let exitFlag;
    try {
      exitFlag = await run([id, '--wait', '--exit-status'], { cwd: tempDir });
    } finally {
      capFlag.restore();
    }
    const capPlain = captureStdio();
    let exitPlain;
    try {
      exitPlain = await run([id, '--wait'], { cwd: tempDir });
    } finally {
      capPlain.restore();
    }

    assert.equal(exitFlag, 1);
    assert.equal(exitPlain, 0);
    assert.equal(capFlag.out.join(''), capPlain.out.join(''));
    assert.equal(capFlag.err.join(''), '');
    assert.equal(capPlain.err.join(''), '');
  });

  it('cancelled: exit 2 with the flag, exit 0 without, output unchanged', async () => {
    const id = 'e00000000004';
    await makeJob(tempDir, id, 'cancelled');
    const { run } = await import('../scripts/commands/status.mjs');

    const capFlag = captureStdio();
    let exitFlag;
    try {
      exitFlag = await run([id, '--wait', '--exit-status'], { cwd: tempDir });
    } finally {
      capFlag.restore();
    }
    const capPlain = captureStdio();
    let exitPlain;
    try {
      exitPlain = await run([id, '--wait'], { cwd: tempDir });
    } finally {
      capPlain.restore();
    }

    assert.equal(exitFlag, 2);
    assert.equal(exitPlain, 0);
    assert.equal(capFlag.out.join(''), capPlain.out.join(''));
    assert.equal(capFlag.err.join(''), '');
    assert.equal(capPlain.err.join(''), '');
  });

  it('wait timeout (still running): exit 3 and one stderr line with the flag; exit 0 and silent without it', async () => {
    const id = 'e00000000005';
    await makeJob(tempDir, id, 'running');
    const { run } = await import('../scripts/commands/status.mjs');

    const capFlag = captureStdio();
    let exitFlag;
    try {
      exitFlag = await run([id, '--wait', '--exit-status', '--timeout-ms', '1'], { cwd: tempDir });
    } finally {
      capFlag.restore();
    }
    const capPlain = captureStdio();
    let exitPlain;
    try {
      exitPlain = await run([id, '--wait', '--timeout-ms', '1'], { cwd: tempDir });
    } finally {
      capPlain.restore();
    }

    assert.equal(exitFlag, 3);
    assert.equal(exitPlain, 0);
    assert.equal(stripElapsed(capFlag.out.join('')), stripElapsed(capPlain.out.join('')));
    assert.equal(capFlag.err.join(''), `antigravity:status — wait timed out; job ${id} is still running.\n`);
    assert.equal(capPlain.err.join(''), '');
  });

  it('wait timeout --json (still queued): exit 3 with the flag; envelope unchanged; stderr differs only by the new line', async () => {
    const id = 'e00000000006';
    await makeJob(tempDir, id, 'queued');
    const { run } = await import('../scripts/commands/status.mjs');

    const capFlag = captureStdio();
    let exitFlag;
    try {
      exitFlag = await run([id, '--wait', '--exit-status', '--json', '--timeout-ms', '1'], { cwd: tempDir });
    } finally {
      capFlag.restore();
    }
    const capPlain = captureStdio();
    let exitPlain;
    try {
      exitPlain = await run([id, '--wait', '--json', '--timeout-ms', '1'], { cwd: tempDir });
    } finally {
      capPlain.restore();
    }

    assert.equal(exitFlag, 3);
    assert.equal(exitPlain, 0);
    assert.equal(stripElapsed(capFlag.out.join('')), stripElapsed(capPlain.out.join('')));
    const payload = JSON.parse(capFlag.out.join(''));
    assert.equal(payload.status, 'queued');
    assert.equal(payload.jobId, id);
    assert.equal(capFlag.err.join(''), `antigravity:status — wait timed out; job ${id} is still queued.\n`);
    assert.equal(capPlain.err.join(''), '');
  });

  it('vanished job record (finding: exitStatusOutcome unguarded on undefined job): exit 3, one stderr line, no TypeError anywhere', async () => {
    const id = 'exitstatus-vanished';
    // A pre-wait read that finds the job (so validation and the initial
    // snapshot succeed), then every later call — inside the wait loop and
    // the post-deadline re-read — reports the record as gone. Matches the
    // documented case `withDenialRemedies`'s own doc comment names: "a
    // `--wait` timeout on a vanished record". No `workspaceRoot` key on the
    // stub snapshot, matching the shape `buildSingleJobSnapshot` itself
    // would produce if it ever returned a missing job instead of throwing.
    let calls = 0;
    const buildSingleJobSnapshot = () => {
      calls += 1;
      if (calls === 1) return { job: { id, status: 'running' } };
      return { job: undefined };
    };
    const { run } = await import('../scripts/commands/status.mjs');

    const cap = captureStdio();
    let exit;
    try {
      exit = await run([id, '--wait', '--exit-status', '--timeout-ms', '1'], {
        cwd: tempDir,
        buildSingleJobSnapshot,
      });
    } finally {
      cap.restore();
    }

    assert.equal(exit, 3);
    assert.equal(cap.err.join(''), 'antigravity:status — job record vanished while waiting.\n');
    assert.ok(!cap.err.join('').includes('TypeError'));
    assert.ok(!cap.out.join('').includes('TypeError'));
  });
});
