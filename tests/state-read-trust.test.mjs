/**
 * Reads of shared-temp state run the same trust check as writes.
 *
 * `assertPrivateDir` is a no-op on win32, so the wiring cases below replace
 * it (through the module mock) with a fake that refuses a chosen set of
 * directories. That way the read-path logic runs on every OS; the real
 * owner, mode and symlink checks are pinned by the seam cases at the top and
 * by the POSIX-only cases in state-root-trust.test.mjs.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';
import * as realFs from '../scripts/lib/fs.mjs';

const { UnsafeStateDirError } = realFs;

const distrusted = new Set();
mock.module('../scripts/lib/fs.mjs', {
  namedExports: {
    ...realFs,
    assertPrivateDir: (dir) => {
      if (distrusted.has(path.resolve(dir))) {
        throw new UnsafeStateDirError(`${dir} is not a private directory owned by this user`);
      }
    },
  },
});
mock.module('../scripts/lib/git.mjs', {
  namedExports: { ensureGitRepository: (cwd) => cwd },
});

const { listJobs, readJobFile, resolveStateDir, resolveJobLogFile, upsertJob, writeJobFile, appendJobLog } =
  await import('../scripts/lib/state.mjs');
const { buildSingleJobSnapshot } = await import('../scripts/lib/job-control.mjs');
const { run: cancel } = await import('../scripts/commands/cancel.mjs');

const TMPROOT = portableTmpRoot();
const FALLBACK_ROOT = path.join(os.tmpdir(), 'antigravity');
const HOST_VARS = ['CLAUDE_PLUGIN_DATA', 'CODEX_PLUGIN_DATA', 'AGY_PLUGIN_DATA'];
const JOB_ID = 'abcdefabcdef';

function leafFor(dirPath) {
  const slug = path.basename(dirPath)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${slug}-${createHash('sha256').update(dirPath).digest('hex').slice(0, 12)}`;
}

function plantState(stateDir, jobs) {
  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, config: {}, jobs }));
  for (const job of jobs) {
    if (typeof job.id === 'string' && /^[a-f0-9]{12}$/.test(job.id)) {
      fs.writeFileSync(path.join(stateDir, 'jobs', `${job.id}.json`), JSON.stringify(job));
    }
  }
}

function runningJob(overrides = {}) {
  return {
    id: JOB_ID,
    kind: 'task',
    status: 'running',
    phase: 'running',
    workerPid: 4242,
    createdAt: '2026-10-08T12:00:00.000Z',
    updatedAt: '2026-10-08T12:00:05.000Z',
    ...overrides,
  };
}

let savedEnv;
let workCwd;
let dataDir;
const extraDirs = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(HOST_VARS.map((name) => [name, process.env[name]]));
  for (const name of HOST_VARS) delete process.env[name];
  workCwd = fs.realpathSync.native(fs.mkdtempSync(path.join(TMPROOT, 'antigravity-readtrust-cwd-')));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-readtrust-data-'));
  distrusted.clear();
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  distrusted.clear();
  removeTestDir(workCwd);
  removeTestDir(dataDir);
  for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('assertPrivateDir seams: owner, mode and symlink on every OS', () => {
  const stat = (overrides = {}) => ({ isSymbolicLink: () => false, uid: 1000, mode: 0o40700, ...overrides });
  const posix = (st) => ({ platform: 'linux', uid: 1000, lstat: () => st });

  it('accepts a 0700 directory this user owns', () => {
    assert.doesNotThrow(() => realFs.assertPrivateDir('/x', posix(stat())));
  });

  for (const [name, overrides] of [
    ['owned by another uid', { uid: 1001 }],
    ['group-writable', { mode: 0o40770 }],
    ['world-writable', { mode: 0o40707 }],
    ['a symlink', { isSymbolicLink: () => true }],
  ]) {
    it(`refuses a directory that is ${name}`, () => {
      assert.throws(() => realFs.assertPrivateDir('/x', posix(stat(overrides))), UnsafeStateDirError);
    });
  }

  it('is a no-op on win32 and never reads the directory', () => {
    const lstat = () => { throw new Error('lstat must not run on win32'); };
    assert.doesNotThrow(() => realFs.assertPrivateDir('C:\\x', { platform: 'win32', uid: 1000, lstat }));
  });
});

describe('state reads refuse a directory that fails the trust check', () => {
  for (const level of ['state root', 'workspace leaf', 'jobs directory']) {
    it(`a planted ${level} is not read by status, result or cancel, and is not repaired`, async () => {
      process.env.CLAUDE_PLUGIN_DATA = dataDir;
      const leaf = path.join(dataDir, 'state', leafFor(workCwd));
      plantState(leaf, [runningJob()]);
      const dir = { 'state root': path.dirname(leaf), 'workspace leaf': leaf, 'jobs directory': path.join(leaf, 'jobs') }[level];
      distrusted.add(path.resolve(dir));

      assert.throws(() => listJobs(workCwd), UnsafeStateDirError);
      assert.throws(() => readJobFile(workCwd, JOB_ID), UnsafeStateDirError);
      assert.throws(() => buildSingleJobSnapshot(workCwd, JOB_ID), UnsafeStateDirError);

      let signalled = 0;
      const exit = await cancel([JOB_ID, '--json'], {
        cwd: workCwd,
        isProcessAlive: () => true,
        readProcessStartTime: () => 0,
        terminateProcessTree: async () => { signalled += 1; return { outcome: 'killed' }; },
        outputCommandResult: () => {},
      });
      assert.equal(exit, 1);
      assert.equal(signalled, 0);
      assert.deepEqual(fs.readdirSync(leaf).sort(), ['jobs', 'state.json'], 'no quarantine or rebuild in a refused directory');
    });
  }

  it('a legacy temp leaf that fails the check is skipped; the preferred leaf is used', () => {
    process.env.AGY_PLUGIN_DATA = dataDir;
    const legacy = path.join(FALLBACK_ROOT, leafFor(workCwd));
    extraDirs.push(legacy);
    plantState(legacy, [runningJob()]);
    distrusted.add(path.resolve(legacy));

    assert.equal(resolveStateDir(workCwd), path.join(dataDir, 'state', leafFor(workCwd)));
    assert.deepEqual(listJobs(workCwd), []);
  });

  it('a trusted legacy temp leaf is still used, so existing jobs stay reachable', () => {
    process.env.AGY_PLUGIN_DATA = dataDir;
    const legacy = path.join(FALLBACK_ROOT, leafFor(workCwd));
    extraDirs.push(legacy);
    plantState(legacy, [runningJob()]);

    assert.equal(resolveStateDir(workCwd), legacy);
    assert.deepEqual(listJobs(workCwd).map((job) => job.id), [JOB_ID]);
  });

  it('a failing legacy leaf is skipped and the next candidate is used', (t) => {
    const linkParent = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-readtrust-link-'));
    extraDirs.push(linkParent);
    const link = path.join(linkParent, 'workspace-link');
    try {
      fs.symlinkSync(workCwd, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a junction or symlink here: ${err.code}`);
      return;
    }
    process.env.AGY_PLUGIN_DATA = dataDir;
    // Candidate order for a linked workspace: <host root>/<logical leaf>,
    // then <temp root>/<real leaf>, then <temp root>/<logical leaf>.
    const first = path.join(dataDir, 'state', leafFor(link));
    const next = path.join(FALLBACK_ROOT, leafFor(workCwd));
    extraDirs.push(next);
    plantState(first, [runningJob({ id: '111111111111' })]);
    plantState(next, [runningJob({ id: '222222222222' })]);
    distrusted.add(path.resolve(first));

    assert.equal(resolveStateDir(link), next);
    assert.deepEqual(listJobs(link).map((job) => job.id), ['222222222222']);
  });
});

describe('state index entries are validated on read', () => {
  it('drops entries the job record validator rejects', () => {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    plantState(path.join(dataDir, 'state', leafFor(workCwd)), [
      runningJob(),
      runningJob({ id: '../../../evil' }),
      runningJob({ id: '333333333333', status: 'hijacked' }),
      runningJob({ id: '444444444444', workerPid: -1 }),
      runningJob({ id: '555555555555', agyPid: 'x' }),
    ]);
    assert.deepEqual(listJobs(workCwd).map((job) => job.id), [JOB_ID]);
  });
});

describe('status reads only the plugin\'s own job log path', () => {
  beforeEach(() => {
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });

  async function seed(logFile) {
    await upsertJob(workCwd, runningJob({ logFile, startedAt: new Date().toISOString() }));
    await writeJobFile(workCwd, JOB_ID, runningJob({ logFile }));
  }

  it('a logFile outside the job log path is not read', async () => {
    const secret = path.join(dataDir, 'id_rsa');
    fs.writeFileSync(secret, 'SECRET-KEY-LINE\n');
    await seed(secret);
    const { job } = buildSingleJobSnapshot(workCwd, JOB_ID);
    assert.equal(job.recentProgress, undefined);
    assert.doesNotMatch(JSON.stringify(job), /SECRET-KEY-LINE/);
  });

  it('the plugin\'s own job log is read', async () => {
    await seed(resolveJobLogFile(workCwd, JOB_ID));
    appendJobLog(workCwd, JOB_ID, 'own progress line');
    const { job } = buildSingleJobSnapshot(workCwd, JOB_ID);
    assert.equal(job.recentProgress.length, 1);
    assert.match(job.recentProgress[0], /own progress line$/);
  });
});

