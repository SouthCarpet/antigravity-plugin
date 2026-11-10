// Oracle: package I briefs, hard identity limit and rulings 1 through 3.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForJob, patchJob, cleanupConfirmedTools } from '../scripts/lib/job-helpers.mjs';
import { resolveJobLogFile, resolveStateDir } from '../scripts/lib/state.mjs';
import { createHash } from 'node:crypto';
import { canonicalComparePath, expandShortPath } from '../scripts/lib/paths.mjs';
import { queryProcessChildren } from '../scripts/lib/process.mjs';
import { createJobActivityRecorder } from '../scripts/lib/job-activity.mjs';
import { run as cancel } from '../scripts/commands/cancel.mjs';
import { removeTestDir } from './helpers/tmp.mjs';
const roots = [];
const saved = process.env.CLAUDE_PLUGIN_DATA;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = saved;
  for (const root of roots.splice(0)) removeTestDir(root);
});
const job = { id: 'abcdef123456', status: 'running', workerPid: 400,
  agyPid: 500, agyProcessStartedAt: '2026-11-10T10:00:00.000Z',
  agyAliveAt: '2026-11-10T10:00:15.000Z', lastHeartbeatAt: '2026-11-10T10:00:30.000Z' };
const tool = { pid: 600, parentPid: 500, startedAt: '2026-11-10T10:00:05.000Z' };
async function fixture(fields = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-orphan-'));
  roots.push(root);
  process.env.CLAUDE_PLUGIN_DATA = root;
  await patchJob(root, job.id, { ...job, ...fields });
  return root;
}
function dependencies(root, rows = [tool]) {
  const signals = [];
  let queries = 0;
  return { signals, get queries() { return queries; }, platform: 'win32',
    isProcessAlive: pid => pid === 600,
    readStartTime: () => Date.parse(rows?.[0]?.startedAt ?? tool.startedAt),
    queryChildren: () => {
      queries++;
      const hash = createHash('sha256').update(canonicalComparePath(resolveStateDir(root))).digest('hex');
      assert.equal(fs.existsSync(path.join(expandShortPath(os.tmpdir()), 'antigravity-state-locks', `${hash}.lock`)), false, 'query outside mutex');
      return { rows, reason: rows === null ? "spawn_failed" : null };
    },
    terminateTree: async pid => { signals.push(pid); return { outcome: 'killed' }; },
  };
}
test('gone worker and gone agy stop only the confirmed tool and preserve worker_missing', async () => {
  const root = await fixture();
  const deps = dependencies(root);
  const result = await waitForJob(root, job.id, deps);
  assert.equal(result.status, 'failed');
  assert.equal(result.healthStatus, 'worker_missing');
  assert.deepEqual(deps.signals, [600]);
  assert.equal(deps.queries, 1);
});
for (const [name, candidate] of [
  ['after alive bound but before later heartbeat', { ...tool, startedAt: '2026-11-10T10:00:20.000Z' }],
  ['before agy launch', { ...tool, startedAt: '2026-11-10T09:59:59.999Z' }],
  ['another creator', { ...tool, parentPid: 501 }],
  ['unreadable creation time', { ...tool, startedAt: 'unknown' }],
]) test(`${name}: tool not signalled, one log line`, async () => {
  const root = await fixture();
  const deps = dependencies(root, [candidate]);
  await waitForJob(root, job.id, deps);
  assert.deepEqual(deps.signals, []);
  assert.equal(fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8').split('not signalled').length - 1, 1);
});
for (const [name, fields] of [
  ['legacy record', { agyAliveAt: undefined }],
  ['no launch bound', { agyProcessStartedAt: undefined }],
]) test(`${name}: no creator query and no signal`, async () => {
  const root = await fixture(fields);
  const deps = dependencies(root);
  await waitForJob(root, job.id, deps);
  assert.equal(deps.queries, 0);
  assert.deepEqual(deps.signals, []);
});
for (const [name, override] of [
  ['POSIX', { platform: 'linux' }],
  ['reused agy PID', { isProcessAlive: pid => pid === 500, readStartTime: () => Date.parse('2026-11-10T11:00:00Z') }],
  ['agy without identity', { isProcessAlive: pid => pid === 500, readStartTime: () => null }],
]) test(`${name}: no creator query`, async () => {
  const root = await fixture();
  const deps = dependencies(root);
  await waitForJob(root, job.id, { ...deps, ...override });
  assert.equal(deps.queries, 0);
  assert.deepEqual(deps.signals, []);
});
for (const [name, override] of [
  ['ended candidate', { isProcessAlive: () => false }],
  ['reused candidate', { readStartTime: () => Date.parse('2026-11-10T11:00:00Z') }],
  ['unreadable candidate', { readStartTime: () => null }],
]) test(`${name}: identity recheck prevents signal`, async () => {
  const root = await fixture();
  const deps = dependencies(root);
  await waitForJob(root, job.id, { ...deps, ...override });
  assert.deepEqual(deps.signals, []);
});
for (const [name, rows] of [['failed query', null], ['too many candidates', Array(65).fill(tool)]]) {
  test(`${name}: one log line and worker_missing`, async () => {
    const root = await fixture();
    const deps = dependencies(root, rows);
    const result = await waitForJob(root, job.id, deps);
    assert.equal(result.healthStatus, 'worker_missing');
    assert.deepEqual(deps.signals, []);
    assert.equal(fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8').split('not signalled').length - 1, 1);
  });
}
for (const [name, reply] of [
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }],
  ['exit_nonzero', { status: 1 }], ['malformed', { status: 0, stdout: 'oops' }],
  ['spawn_failed', { status: null, error: { code: 'ENOENT' } }],
  ['too_many', { status: 0, stdout: JSON.stringify(Array(10000).fill(tool)) }],
  ['malformed', { status: 0, stdout: '[{}]' }],
]) test(`${name}: bounded adapter query rejects entire answer`, () => {
  let calls = 0;
  const result = queryProcessChildren(500, { platform: 'win32', spawnSyncImpl: (_bin, _args, options) => {
    calls++;
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 65536);
    return reply;
  } });
  assert.deepEqual(result, { rows: null, reason: name });
  assert.equal(calls, 1);
});
test('heartbeat after child exit advances heartbeat but preserves older agyAliveAt', async () => {
  let time = Date.parse('2026-11-10T10:00:00.000Z');
  let live = true;
  let tick;
  const patches = [];
  const activity = createJobActivityRecorder('root', 'job', { heartbeat: true, now: () => time,
    patch: async (_root, _id, fields) => patches.push(fields),
    setIntervalImpl: callback => { tick = callback; return { unref() {} }; }, clearIntervalImpl() {} });
  activity.setAgyIsAlive(() => live);
  assert.deepEqual(activity.agyAliveFields(), { agyAliveAt: '2026-11-10T10:00:00.000Z' });
  time = Date.parse('2026-11-10T10:00:15.000Z');
  tick();
  await new Promise(resolve => setImmediate(resolve));
  live = false;
  time = Date.parse('2026-11-10T10:00:30.000Z');
  tick();
  await activity.finish();
  assert.deepEqual(patches, [
    { lastHeartbeatAt: '2026-11-10T10:00:15.000Z', agyAliveAt: '2026-11-10T10:00:15.000Z' },
    { lastHeartbeatAt: '2026-11-10T10:00:30.000Z' },
  ]);
});
test('foreground recorder has no agyAliveAt writer', async () => {
  const fields = [];
  const activity = createJobActivityRecorder('root', 'job', { now: () => 0,
    patch: async (_root, _id, value) => fields.push(value) });
  activity.onText(); await activity.finish();
  assert.deepEqual(fields, [{ lastProgressAt: '1970-01-01T00:00:00.000Z', lastModelOutputAt: '1970-01-01T00:00:00.000Z' }]);
});
test('two waiters preserve one terminal record and tolerate ended tool', async () => {
  const root = await fixture();
  const deps = dependencies(root);
  const [first, second] = await Promise.all([waitForJob(root, job.id, deps), waitForJob(root, job.id, deps)]);
  assert.deepEqual(first, second);
  assert.equal(first.healthStatus, 'worker_missing');
});

for (const status of ['running', 'failed']) test(`${status} healthy or normal failure: zero creator queries`, async () => {
  const root = await fixture({ status });
  const deps = dependencies(root);
  let time = 0;
  await waitForJob(root, job.id, { ...deps, isProcessAlive: () => true,
    timeoutMs: 1, now: () => time++, sleep: async () => {} });
  assert.equal(deps.queries, 0);
  assert.deepEqual(deps.signals, []);
});

test('cancel live agy does not query tools after the worker stops it', async () => {
  const root = await fixture({ workerProcessStartedAt: job.agyProcessStartedAt });
  const deps = dependencies(root);
  let alive = true;
  const code = await cancel([job.id, '--json'], { cwd: root, platform: 'win32',
    isProcessAlive: () => alive, readProcessStartTime: () => Date.parse(job.agyProcessStartedAt),
    queryChildren: deps.queryChildren, outputCommandResult() {},
    terminateProcessTree: async pid => { alive = false; return { pid, outcome: 'killed' }; },
  });
  assert.equal(code, 0);
  assert.equal(deps.queries, 0);
});

test('Windows killed worker: confirmed early tool stops, two-second late tool stays', {
  skip: process.platform !== 'win32' ? 'Windows creator PID and process-handle contract' : false,
  timeout: 65000,
}, async (t) => {
  const { compileCsharpExe } = await import('./helpers/fake-agy.mjs');
  const { startBackgroundJob } = await import('../scripts/lib/job-helpers.mjs');
  const { readJobFile } = await import('../scripts/lib/state.mjs');
  const { isProcessAlive, terminateProcessTree, checkProcessIdentity } = await import('../scripts/lib/process.mjs');
  const root = await fixture({ status: 'completed' });
  const bin = path.join(root, 'agy.exe');
  const template = compileCsharpExe(`using System;using System.IO;using System.Diagnostics;using System.Threading;
class Program { static void Main(string[] args) {
if(Array.IndexOf(args,"--version")>=0){Console.WriteLine("agy 1.5.3");return;}
if(Array.IndexOf(args,"--help")>=0){Console.WriteLine("--print --input-format --output-format");return;}
if(Array.IndexOf(args,"models")>=0){Console.WriteLine("[]");return;}
string exe=Process.GetCurrentProcess().MainModule.FileName;
var early=Process.Start(new ProcessStartInfo("ping.exe","-n 180 127.0.0.1"){UseShellExecute=false,CreateNoWindow=true});
File.WriteAllText(exe+".early-start",early.StartTime.ToUniversalTime().ToString("o"));
File.WriteAllText(exe+".early",early.Id.ToString());
DateTime deadline=DateTime.UtcNow.AddSeconds(45);
while(!File.Exists(exe+".late-go")){if(DateTime.UtcNow>deadline)return;Thread.Sleep(20);}
var late=Process.Start(new ProcessStartInfo("ping.exe","-n 180 127.0.0.1"){UseShellExecute=false,CreateNoWindow=true});
File.WriteAllText(exe+".late-start",late.StartTime.ToUniversalTime().ToString("o"));
File.WriteAllText(exe+".late",late.Id.ToString());Thread.Sleep(180000);
} }`);
  fs.copyFileSync(template, bin);
  const ids = [];
  const identities = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(probe) {
    const deadline = Date.now() + 30000;
    while (!probe()) { assert.ok(Date.now() < deadline, 'fake job reached checkpoint'); await sleep(50); }
  }
  let launched;
  try {
    launched = await startBackgroundJob({ workspaceRoot: root, kind: 'task', prompt: 'stay',
      env: { ...process.env, AGY_BIN: bin } });
    ids.push(launched.pid);
    let record;
    await until(() => {
      record = readJobFile(root, launched.job.id);
      return record?.agyProcessStartedAt && record?.agyAliveAt && record?.lastHeartbeatAt && fs.existsSync(bin + '.early');
    });
    ids.push(record.agyPid, Number(fs.readFileSync(bin + '.early', 'utf8')));
    assert.equal(checkProcessIdentity(launched.pid, record.workerProcessStartedAt), 'match', 'kill only our confirmed worker');
    fs.writeFileSync(bin + '.late-go', 'go');
    await until(() => fs.existsSync(bin + '.late'));
    ids.push(Number(fs.readFileSync(bin + '.late', 'utf8')));
    await sleep(2000); // Specified measured limit, not a readiness wait.
    const atKill = readJobFile(root, launched.job.id);
    const earlyStartedAt = fs.readFileSync(bin + '.early-start', 'utf8');
    const lateStartedAt = fs.readFileSync(bin + '.late-start', 'utf8');
    assert.ok(Date.parse(lateStartedAt) > Date.parse(atKill.agyAliveAt), 'late tool is outside the last live-child bound');
    const killTriggeredAt = new Date().toISOString();
    process.kill(launched.pid, 'SIGKILL');
    await until(() => !isProcessAlive(launched.pid) && !isProcessAlive(record.agyPid));
    const result = await waitForJob(root, launched.job.id);
    t.diagnostic(JSON.stringify({ atKill, ids, earlyStartedAt, lateStartedAt, killTriggeredAt,
      lateAgeMs: Date.parse(killTriggeredAt) - Date.parse(lateStartedAt),
      log: fs.readFileSync(resolveJobLogFile(root, launched.job.id), 'utf8') }));
    assert.equal(result.healthStatus, 'worker_missing');
    assert.equal(isProcessAlive(ids[2]), false, 'early confirmed tool stopped');
    assert.equal(isProcessAlive(ids[3]), true, 'late unconfirmed tool untouched');
  } finally {
    if (launched) {
      const finalRecord = readJobFile(root, launched.job.id);
      identities.set(launched.pid, finalRecord?.workerProcessStartedAt);
      if (finalRecord?.agyPid) {
        ids.push(finalRecord.agyPid);
        identities.set(finalRecord.agyPid, finalRecord.agyProcessStartedAt);
      }
      t.diagnostic(JSON.stringify({ finalRecord, log: fs.readFileSync(resolveJobLogFile(root, launched.job.id), 'utf8') }));
    }
    for (const suffix of ['.early', '.late']) {
      if (fs.existsSync(bin + suffix)) {
        const pid = Number(fs.readFileSync(bin + suffix, 'utf8'));
        ids.push(pid);
        identities.set(pid, fs.readFileSync(bin + suffix + '-start', 'utf8'));
      }
    }
    for (const pid of new Set(ids)) {
      const identity = checkProcessIdentity(pid, identities.get(pid));
      if (identity === 'match') await terminateProcessTree(pid);
      else if (identity !== 'gone') t.diagnostic(`test cleanup pid=${pid} not signalled: ${identity}`);
    }
  }
});
for (const candidate of [tool, { ...tool, startedAt: '2026-11-10T10:00:20.000Z' }]) {
  test(`cancel gone agy with tool at ${candidate.startedAt} keeps the base envelope`, async () => {
    const root = await fixture({ workerPid: null, pid: null });
    const deps = dependencies(root, [candidate]);
    let envelope;
    const code = await cancel([job.id, '--json'], { cwd: root,
      platform: 'win32', queryChildren: deps.queryChildren,
      isProcessAlive: deps.isProcessAlive, readProcessStartTime: deps.readStartTime,
      terminateProcessTree: deps.terminateTree, outputCommandResult: value => { envelope = value; } });
    assert.equal(code, 0);
    assert.equal(envelope.status, 'cancelled');
    assert.deepEqual(envelope.details, { pid: 0, workerPid: null, agyPid: 500, killed: false, stopped: true,
      termination: [{ role: 'agy', outcome: 'not_found', killed: false, pid: 500, status: null, attempts: [], message: 'Process 500 is not running.' }] });
    assert.deepEqual(deps.signals, candidate === tool ? [600] : []);
  });
}
for (const [reason, reply] of [
  ['timeout', { status: null, error: { code: 'ETIMEDOUT' } }],
  ['spawn_failed', { status: null, error: { code: 'ENOENT' } }],
  ['exit_nonzero', { status: 1, stdout: 'private path' }],
  ['malformed', { status: 0, stdout: 'garbage private path' }],
  ['too_many', { status: 0, stdout: JSON.stringify(Array(65).fill(tool)) }],
]) test(`unusable ${reason}: exact safe reason in job log and no signal`, async () => {
  const root = await fixture();
  const deps = dependencies(root);
  const result = await waitForJob(root, job.id, { ...deps,
    queryChildren: pid => queryProcessChildren(pid, { platform: 'win32', spawnSyncImpl: () => reply }) });
  assert.equal(result.healthStatus, 'worker_missing');
  assert.deepEqual(deps.signals, []);
  const lines = fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8').split('\n')
    .filter(line => line.includes('creator query')).map(line => line.slice(line.indexOf('[wait]')));
  assert.deepEqual(lines, [`[wait] tools not signalled: creator query ${reason}`]);
});

test('creator answer at six seconds is used with the fifteen-second timeout', async () => {
  const root = await fixture();
  const deps = dependencies(root);
  let time = 0;
  await waitForJob(root, job.id, { ...deps, cleanupNow: () => time,
    queryChildren: pid => queryProcessChildren(pid, { platform: 'win32', spawnSyncImpl: (_bin, _args, options) => {
      time = 6000;
      assert.equal(options.timeout, 15000);
      return { status: 0, stdout: JSON.stringify([tool]) };
    } }) });
  assert.deepEqual(deps.signals, [600]);
});

for (const mode of ['wait', 'cancel']) test(`${mode}: one total budget leaves two remaining confirmed tools untouched`, async () => {
  const root = await fixture({ workerPid: null, pid: 400 });
  const signals = [];
  let time = 0;
  const deps = { platform: 'win32', cleanupNow: () => time,
    isProcessAlive: pid => pid >= 600,
    readStartTime: () => Date.parse(tool.startedAt),
    queryChildren: () => ({ rows: [tool, { ...tool, pid: 601 }, { ...tool, pid: 602 }], reason: null }),
    terminateTree: async pid => { signals.push(pid); time += 61000; return { outcome: 'killed' }; } };
  if (mode === 'wait') {
    const result = await waitForJob(root, job.id, deps);
    assert.equal(result.healthStatus, 'worker_missing');
  } else {
    let envelope;
    const code = await cancel([job.id, '--json'], { cwd: root, ...deps,
      readProcessStartTime: deps.readStartTime, terminateProcessTree: deps.terminateTree,
      outputCommandResult: value => { envelope = value; } });
    assert.equal(code, 0);
    assert.deepEqual(envelope.details, { pid: 400, workerPid: 400, agyPid: 500, killed: false, stopped: true,
      termination: [
        { role: 'worker', outcome: 'not_found', killed: false, pid: 400, status: null, attempts: [], message: 'Process 400 is not running.' },
        { role: 'agy', outcome: 'not_found', killed: false, pid: 500, status: null, attempts: [], message: 'Process 500 is not running.' },
      ] });
  }
  assert.deepEqual(signals, [600]);
  const lines = fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8').split('\n')
    .filter(line => line.includes('cleanup time budget')).map(line => line.slice(line.indexOf(`[${mode}]`)));
  assert.deepEqual(lines, [
    `[${mode}] tool pid=601 of agy pid=500 not signalled: cleanup time budget used`,
    `[${mode}] tool pid=602 of agy pid=500 not signalled: cleanup time budget used`,
  ]);
});

test('identity check finishes after deadline: candidate is never signalled', async () => {
  const root = await fixture();
  const deps = dependencies(root);
  let time = 0;
  let completed = false;
  await waitForJob(root, job.id, { ...deps, cleanupNow: () => time,
    readStartTime: () => { time = 61000; completed = true; return Date.parse(tool.startedAt); } });
  assert.equal(completed, true);
  assert.deepEqual(deps.signals, []);
  assert.match(fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8'), /not signalled: cleanup time budget used/);
});

test('query consumes total budget: even a confirmed answer signals nothing', async () => {
  const root = await fixture();
  const deps = dependencies(root);
  let time = 0;
  await waitForJob(root, job.id, { ...deps, cleanupNow: () => time,
    queryChildren: () => { time = 61000; return { rows: [tool], reason: null }; } });
  assert.deepEqual(deps.signals, []);
  assert.match(fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8'), /not signalled: cleanup time budget used/);
});

test('unsupported creator query: safe reason and no signal', async () => {
  const root = await fixture();
  const deps = dependencies(root);
  await waitForJob(root, job.id, { ...deps,
    queryChildren: () => queryProcessChildren(500, { platform: 'linux' }) });
  assert.deepEqual(deps.signals, []);
  const lines = fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8').split('\n')
    .filter(line => line.includes('creator query')).map(line => line.slice(line.indexOf('[wait]')));
  assert.deepEqual(lines, ['[wait] tools not signalled: creator query unsupported']);
});

// Oracle: fix-2 ruling 2. Reserved rows must not reach identity or termination.
for (const pid of [process.pid, process.ppid, 400, 500, 0, 4]) {
  test(`reserved pid ${pid}: no identity read or signal, valid sibling still stops`, async () => {
    const root = await fixture();
    const reads = [];
    const deps = dependencies(root, [{ ...tool, pid }, tool]);
    await cleanupConfirmedTools(root, job, { ...deps,
      isProcessAlive: value => { reads.push(value); return true; },
    });
    assert.deepEqual(reads, [600]);
    assert.deepEqual(deps.signals, [600]);
    const lines = fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8').split('\n')
      .filter(line => line.includes('reserved process id'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith(`tool pid=${pid} of agy pid=500 not signalled: reserved process id`));
  });
}
for (const fields of [{ workerPid: undefined, agyPid: undefined }, { workerPid: 'bad', agyPid: 'bad' }]) {
  test(`invalid reserved record ${JSON.stringify(fields)}: valid candidate is checked`, async () => {
    const root = await fixture();
    const reads = [];
    const deps = dependencies(root);
    await cleanupConfirmedTools(root, { ...job, ...fields }, { ...deps,
      isProcessAlive: pid => { reads.push(pid); return true; },
    });
    // Without a numeric creator the row is unconfirmed, not reserved.
    assert.deepEqual(deps.signals, []);
    assert.deepEqual(reads, []);
    assert.doesNotMatch(fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8'), /reserved process id/);
  });
}
for (const workerPid of [undefined, 'bad']) test(`worker PID ${workerPid} does not reserve a valid confirmed tool`, async () => {
  const root = await fixture();
  const deps = dependencies(root);
  await cleanupConfirmedTools(root, { ...job, workerPid }, deps);
  assert.deepEqual(deps.signals, [600]);
});

// Oracle: fix-2 ruling 1a. The sample belongs to the tick, before its queued write.
test('exit immediately after heartbeat tick preserves the tick sample in the queued patch', async () => {
  let time = Date.parse('2026-11-10T10:00:15.000Z');
  let live = true;
  let tick;
  const patches = [];
  const activity = createJobActivityRecorder('root', 'job', { heartbeat: true, now: () => time,
    patch: async (_root, _id, fields) => patches.push(fields),
    setIntervalImpl: callback => { tick = callback; return { unref() {} }; }, clearIntervalImpl() {} });
  activity.setAgyIsAlive(() => live);
  tick();
  live = false;
  time = Date.parse('2026-11-10T10:00:16.000Z');
  await activity.finish();
  assert.deepEqual(patches, [{ lastHeartbeatAt: '2026-11-10T10:00:15.000Z', agyAliveAt: '2026-11-10T10:00:15.000Z' }]);
});
