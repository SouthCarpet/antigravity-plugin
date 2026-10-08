/**
 * Process identity: `cancel` and the vanished-worker cleanup in
 * `waitForJob` signal a PID read from a job record only while the OS start
 * time of that PID matches the start time recorded at launch.
 *
 * The "OS" in most cases is a fake: `isProcessAlive` and the start-time read
 * are injected, so a reused PID (another process with the same number) can
 * be modelled exactly. The last cases read real start times of a real
 * child process.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';
import {
  readJobFile, readLogTail, resolveJobLogFile, upsertJob, validateJobRecord, writeJobFile,
} from '../scripts/lib/state.mjs';
import { run as cancel } from '../scripts/commands/cancel.mjs';
import { startBackgroundJob, waitForJob } from '../scripts/lib/job-helpers.mjs';
import {
  PROCESS_IDENTITY_TOLERANCE_MS,
  checkProcessIdentity,
  readProcessStartTime,
  recordProcessStartTime,
} from '../scripts/lib/process.mjs';

const TMPROOT = portableTmpRoot();
const HOST_VARS = ['CLAUDE_PLUGIN_DATA', 'CODEX_PLUGIN_DATA', 'AGY_PLUGIN_DATA'];
const JOB_ID = 'abcdefabcdef';
const WORKER_PID = 4242;
const AGY_PID = 5151;
const RECORDED = '2026-10-08T12:00:01.000Z';
const RECORDED_MS = Date.parse(RECORDED);
const AGY_RECORDED = '2026-10-08T12:00:02.500Z';
const AGY_RECORDED_MS = Date.parse(AGY_RECORDED);

let savedEnv;
let workCwd;
let dataDir;

beforeEach(() => {
  savedEnv = Object.fromEntries(HOST_VARS.map((name) => [name, process.env[name]]));
  for (const name of HOST_VARS) delete process.env[name];
  workCwd = fs.realpathSync.native(fs.mkdtempSync(path.join(TMPROOT, 'antigravity-identity-cwd-')));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-identity-data-'));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  removeTestDir(workCwd);
  removeTestDir(dataDir);
});

function runningJob(overrides = {}) {
  return {
    id: JOB_ID,
    kind: 'task',
    status: 'running',
    phase: 'running',
    pid: WORKER_PID,
    workerPid: WORKER_PID,
    workerProcessStartedAt: RECORDED,
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:05.000Z',
    ...overrides,
  };
}

async function seed(job) {
  await upsertJob(workCwd, job);
  await writeJobFile(workCwd, job.id, job);
}

/**
 * A fake OS: `startTimes` maps a PID to its current start time in ms
 * (null: the read fails); a PID that is not a key is not running. `alive`
 * overrides liveness with a list of answers, one per call.
 */
function fakeOs(startTimes, { alive } = {}) {
  const answers = alive ? [...alive] : null;
  return {
    isProcessAlive: (pid) => (answers ? answers.shift() : Object.hasOwn(startTimes, pid)),
    readProcessStartTime: (pid) => startTimes[pid] ?? null,
  };
}

async function cancelOnce(os) {
  const signalled = [];
  let payload;
  const exit = await cancel([JOB_ID, '--json'], {
    cwd: workCwd,
    ...os,
    terminateProcessTree: async (pid) => {
      signalled.push(pid);
      return { outcome: 'killed', killed: true, pid, status: 0, attempts: [], message: `Process tree ${pid} terminated.` };
    },
    outputCommandResult: (value) => { payload = value; },
  });
  return { exit, signalled, payload };
}

function outcomes(payload) {
  return payload.details.termination.map((t) => [t.role, t.pid, t.outcome]);
}

describe('checkProcessIdentity', () => {
  const deps = (startTime, alive = true) => ({ isProcessAlive: () => alive, readStartTime: () => startTime });

  it('is match only for a live process whose start time is within the tolerance', () => {
    assert.equal(checkProcessIdentity(1, RECORDED, deps(RECORDED_MS)), 'match');
    assert.equal(checkProcessIdentity(1, RECORDED, deps(RECORDED_MS + PROCESS_IDENTITY_TOLERANCE_MS)), 'match');
    assert.equal(checkProcessIdentity(1, RECORDED, deps(RECORDED_MS - PROCESS_IDENTITY_TOLERANCE_MS)), 'match');
    assert.equal(checkProcessIdentity(1, RECORDED, deps(RECORDED_MS + PROCESS_IDENTITY_TOLERANCE_MS + 1)), 'unconfirmed');
    assert.equal(checkProcessIdentity(1, RECORDED, deps(RECORDED_MS - PROCESS_IDENTITY_TOLERANCE_MS - 1)), 'unconfirmed');
  });

  it('is gone, no_identity or unconfirmed in every other case', () => {
    assert.equal(PROCESS_IDENTITY_TOLERANCE_MS, 1_000);
    assert.equal(checkProcessIdentity(1, RECORDED, deps(RECORDED_MS, false)), 'gone');
    assert.equal(checkProcessIdentity(1, undefined, deps(RECORDED_MS)), 'no_identity');
    assert.equal(checkProcessIdentity(1, null, deps(RECORDED_MS)), 'no_identity');
    assert.equal(checkProcessIdentity(1, RECORDED_MS, deps(RECORDED_MS)), 'no_identity');
    assert.equal(checkProcessIdentity(1, 'not a date', deps(RECORDED_MS)), 'no_identity');
    assert.equal(checkProcessIdentity(1, RECORDED, deps(null)), 'unconfirmed');
  });

  it('recordProcessStartTime stores the read as ISO, or null when it cannot be read', () => {
    assert.equal(recordProcessStartTime(7, () => RECORDED_MS), RECORDED);
    assert.equal(recordProcessStartTime(7, () => null), null);
    assert.equal(recordProcessStartTime(null, () => RECORDED_MS), null);
  });
});

describe('cancel signals a stored PID only while its start time matches the recorded one', () => {
  it('signals the job\'s own process (positive control)', async () => {
    await seed(runningJob());
    const { exit, signalled, payload } = await cancelOnce(fakeOs({ [WORKER_PID]: RECORDED_MS }));
    assert.equal(exit, 0);
    assert.deepEqual(signalled, [WORKER_PID]);
    assert.equal(payload.status, 'cancelled');
    assert.equal(readJobFile(workCwd, JOB_ID).status, 'cancelled');
  });

  it('signals within the rounding of the read, and not one millisecond past it', async () => {
    await seed(runningJob());
    const within = await cancelOnce(fakeOs({ [WORKER_PID]: RECORDED_MS + PROCESS_IDENTITY_TOLERANCE_MS }));
    assert.deepEqual(within.signalled, [WORKER_PID]);
    await seed(runningJob());
    const past = await cancelOnce(fakeOs({ [WORKER_PID]: RECORDED_MS + PROCESS_IDENTITY_TOLERANCE_MS + 1 }));
    assert.deepEqual(past.signalled, []);
    assert.equal(past.exit, 1);
  });

  it('does not signal a newer process with the same PID, on the first attempt or the second', async () => {
    await seed(runningJob());
    const reused = fakeOs({ [WORKER_PID]: RECORDED_MS + 60_000 });

    const first = await cancelOnce(reused);
    assert.equal(first.exit, 1);
    assert.equal(first.payload.status, 'cancel_failed');
    assert.deepEqual(outcomes(first.payload), [['worker', WORKER_PID, 'unconfirmed']]);
    assert.match(first.payload.details.message,
      /worker pid 4242: Process 4242 could not be confirmed as this job's worker process/);
    const afterFirst = readJobFile(workCwd, JOB_ID);
    assert.equal(afterFirst.status, 'running');
    assert.ok(Date.parse(afterFirst.updatedAt) > Date.parse(runningJob().updatedAt), 'the failure advanced updatedAt');

    const second = await cancelOnce(reused);
    assert.equal(second.exit, 1);
    assert.deepEqual(outcomes(second.payload), [['worker', WORKER_PID, 'unconfirmed']]);
    assert.deepEqual([...first.signalled, ...second.signalled], []);
    assert.equal(readJobFile(workCwd, JOB_ID).status, 'running');
  });

  it('does not signal an older unrelated process with the same PID', async () => {
    await seed(runningJob());
    const { exit, signalled, payload } = await cancelOnce(fakeOs({ [WORKER_PID]: RECORDED_MS - 3_600_000 }));
    assert.equal(exit, 1);
    assert.deepEqual(signalled, []);
    assert.deepEqual(outcomes(payload), [['worker', WORKER_PID, 'unconfirmed']]);
  });

  it('never signals a legacy record with no start time, and tells the user to stop it', async () => {
    const legacy = runningJob();
    delete legacy.workerProcessStartedAt;
    await seed(legacy);
    // A process the old updatedAt rule accepted: it started before the record.
    const { exit, signalled, payload } = await cancelOnce(fakeOs({ [WORKER_PID]: Date.parse(legacy.updatedAt) - 1_000 }));
    assert.equal(exit, 1);
    assert.deepEqual(signalled, []);
    assert.deepEqual(outcomes(payload), [['worker', WORKER_PID, 'unconfirmed']]);
    assert.match(payload.details.message, /no start time for it .*Stop the process yourself/);
  });

  it('does not signal a process whose start time cannot be read', async () => {
    await seed(runningJob());
    const { exit, signalled, payload } = await cancelOnce(fakeOs({ [WORKER_PID]: null }));
    assert.equal(exit, 1);
    assert.deepEqual(signalled, []);
    assert.deepEqual(outcomes(payload), [['worker', WORKER_PID, 'unconfirmed']]);
  });

  it('checks each role against its own recorded start time', async () => {
    await seed(runningJob({ agyPid: AGY_PID, agyProcessStartedAt: AGY_RECORDED }));
    const { exit, signalled, payload } = await cancelOnce(fakeOs({
      [WORKER_PID]: RECORDED_MS,
      [AGY_PID]: AGY_RECORDED_MS + 60_000,
    }));
    assert.equal(exit, 1);
    assert.deepEqual(signalled, [WORKER_PID]);
    assert.deepEqual(outcomes(payload), [['worker', WORKER_PID, 'killed'], ['agy', AGY_PID, 'unconfirmed']]);
  });

  it('reports a process that is not running, or ends during the read, as not_found without a signal', async () => {
    await seed(runningJob());
    const gone = await cancelOnce(fakeOs({}));
    assert.equal(gone.exit, 0);
    assert.deepEqual(gone.signalled, []);
    assert.deepEqual(outcomes(gone.payload), [['worker', WORKER_PID, 'not_found']]);

    await seed(runningJob());
    const ended = await cancelOnce(fakeOs({ [WORKER_PID]: null }, { alive: [true, false] }));
    assert.equal(ended.exit, 0);
    assert.deepEqual(ended.signalled, []);
    assert.deepEqual(outcomes(ended.payload), [['worker', WORKER_PID, 'not_found']]);
  });
});

describe('the vanished-worker cleanup in waitForJob uses the same check for agyPid', () => {
  const DEAD_WORKER = 909091;

  async function waitWith(agyStartTime, overrides = {}) {
    await seed(runningJob({
      pid: DEAD_WORKER, workerPid: DEAD_WORKER, agyPid: AGY_PID, agyProcessStartedAt: AGY_RECORDED, ...overrides,
    }));
    const terminated = [];
    const os = fakeOs(agyStartTime === undefined ? {} : { [AGY_PID]: agyStartTime });
    const wait = () => waitForJob(workCwd, JOB_ID, {
      pollMs: 5,
      timeoutMs: 2000,
      isProcessAlive: os.isProcessAlive,
      readStartTime: os.readProcessStartTime,
      terminateTree: async (pid) => { terminated.push(pid); return { outcome: 'killed', pid }; },
    });
    return { wait, terminated };
  }

  function assertWorkerMissing(final) {
    assert.equal(final.status, 'failed');
    assert.equal(final.phase, 'worker_missing');
    assert.match(final.errorMessage, /Background worker process 909091 is no longer running\./);
  }

  function logText() {
    return readLogTail(resolveJobLogFile(workCwd, JOB_ID), { lines: 20 }) ?? '';
  }

  it('terminates the job\'s own agy process (positive control)', async () => {
    const { wait, terminated } = await waitWith(AGY_RECORDED_MS);
    assertWorkerMissing(await wait());
    assert.deepEqual(terminated, [AGY_PID]);
  });

  it('does not signal a newer process with the same PID, also with two waiters (a deduplicated request)', async () => {
    const { wait, terminated } = await waitWith(AGY_RECORDED_MS + 60_000);
    const [first, second] = await Promise.all([wait(), wait()]);
    assertWorkerMissing(first);
    assert.equal(second.status, 'failed');
    assert.deepEqual(terminated, []);
    assert.match(logText(), /\[wait\] agy pid=5151 not signalled: not confirmed as this job's process/);
  });

  it('does not signal an older unrelated process with the same PID', async () => {
    const { wait, terminated } = await waitWith(AGY_RECORDED_MS - 3_600_000);
    assertWorkerMissing(await wait());
    assert.deepEqual(terminated, []);
  });

  it('never signals agy from a legacy record with no start time, and still records worker_missing', async () => {
    const { wait, terminated } = await waitWith(AGY_RECORDED_MS, { agyProcessStartedAt: undefined });
    assertWorkerMissing(await wait());
    assert.deepEqual(terminated, []);
    assert.match(logText(), /agy pid=5151 not signalled/);
  });

  it('does not signal agy when its start time cannot be read', async () => {
    const { wait, terminated } = await waitWith(null);
    assertWorkerMissing(await wait());
    assert.deepEqual(terminated, []);
  });

  it('does not signal or log anything for an agy process that already ended', async () => {
    const { wait, terminated } = await waitWith(undefined);
    assertWorkerMissing(await wait());
    assert.deepEqual(terminated, []);
    assert.doesNotMatch(logText(), /not signalled/);
  });

  it('still marks the job worker_missing when terminating a confirmed agy fails', async () => {
    await seed(runningJob({ pid: DEAD_WORKER, workerPid: DEAD_WORKER, agyPid: AGY_PID, agyProcessStartedAt: AGY_RECORDED }));
    const os = fakeOs({ [AGY_PID]: AGY_RECORDED_MS });
    const final = await waitForJob(workCwd, JOB_ID, {
      pollMs: 5,
      timeoutMs: 2000,
      isProcessAlive: os.isProcessAlive,
      readStartTime: os.readProcessStartTime,
      terminateTree: async () => { throw new Error('denied'); },
    });
    assertWorkerMissing(final);
  });
});

describe('the start time is recorded once, at launch', () => {
  it('startBackgroundJob stores the worker\'s start time read right after spawn', async () => {
    const reads = [];
    const { job } = await startBackgroundJob({
      workspaceRoot: workCwd,
      kind: 'task',
      prompt: 'p',
      spawnWorker: () => {
        const child = Object.assign(new EventEmitter(), { pid: 7331, unref() {} });
        setImmediate(() => child.emit('spawn'));
        return child;
      },
      readStartTime: (pid) => { reads.push(pid); return RECORDED_MS; },
    });
    assert.deepEqual(reads, [7331]);
    const stored = readJobFile(workCwd, job.id);
    assert.equal(stored.workerPid, 7331);
    assert.equal(stored.workerProcessStartedAt, RECORDED);
  });

  it('stores null when the worker\'s start time cannot be read', async () => {
    const { job } = await startBackgroundJob({
      workspaceRoot: workCwd,
      kind: 'task',
      prompt: 'p',
      spawnWorker: () => {
        const child = Object.assign(new EventEmitter(), { pid: 7332, unref() {} });
        setImmediate(() => child.emit('spawn'));
        return child;
      },
      readStartTime: () => null,
    });
    assert.equal(readJobFile(workCwd, job.id).workerProcessStartedAt, null);
  });

  it('the job record validator accepts records with and without the new fields', () => {
    const legacy = runningJob();
    delete legacy.workerProcessStartedAt;
    assert.equal(validateJobRecord(legacy), true);
    assert.equal(validateJobRecord(runningJob({ agyPid: AGY_PID, agyProcessStartedAt: AGY_RECORDED })), true);
    assert.equal(validateJobRecord(runningJob({ workerProcessStartedAt: null, agyProcessStartedAt: null })), true);
  });
});

describe('real start times of a real child process', () => {
  const read = (pid) => readProcessStartTime(pid, { queryTimeoutMs: 20_000 });

  it('match the recorded start time, and a different recorded time does not', async () => {
    const child = spawn(process.execPath, ['-e', 'process.send("ready"); process.on("message", () => process.exit(0));'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
      const recorded = recordProcessStartTime(child.pid, read);
      assert.equal(typeof recorded, 'string', 'the start time of a live child can be read');
      assert.equal(checkProcessIdentity(child.pid, recorded, { readStartTime: read }), 'match');
      const earlier = new Date(Date.parse(recorded) - 10_000).toISOString();
      assert.equal(checkProcessIdentity(child.pid, earlier, { readStartTime: read }), 'unconfirmed');
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send('exit');
      await exited;
    }
    assert.equal(checkProcessIdentity(child.pid, RECORDED, { readStartTime: read }), 'gone');
  });
});
