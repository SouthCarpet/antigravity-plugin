/**
 * One clear first line when agy or git is missing.
 *
 * review, rescue, task and vision probe the agy binary before they collect a
 * diff, write a job record or start anything. review maps a missing git to
 * one plain line. A run whose process never starts names the spawn error.
 *
 * agent-runtime.mjs is mocked (before any command module is imported, see
 * tests/commands.test.mjs) so the probe result is under test control and no
 * real agy is spawned on the missing-agy paths. The spawn-death case keeps
 * the real runAgyPrint and empties PATH, so the child really fails to start.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const real = await import('../scripts/lib/agent-runtime.mjs');

const runtime = {
  probe: { ok: false, reason: 'not-installed' },
  calls: [],
  useRealRun: false,
};
mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      runtime.calls.push(opts);
      if (runtime.useRealRun) return real.runAgyPrint(opts);
      return { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
    },
    spawnAgyDetached: (opts) => {
      runtime.calls.push(opts);
      return { pid: 1 };
    },
    resolveAgyBin: real.resolveAgyBin,
    probeAgy: async () => runtime.probe,
    assertAgyBinSpawnable: real.assertAgyBinSpawnable,
    DEFAULT_AGY_BIN: 'agy',
  },
});

const ORIGINAL_ENV = { ...process.env };
let tempDir;
let dataDir;

function captureStdio() {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    out.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
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

/** Everything written under the plugin data dir: empty means no job record. */
function dataFiles() {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { recursive: true }).filter((p) =>
    fs.statSync(path.join(dataDir, p)).isFile(),
  );
}

async function runVerb(verb, argv) {
  const { run } = await import(`../scripts/commands/${verb}.mjs`);
  const cap = captureStdio();
  let exit;
  try {
    exit = await run(argv, { cwd: tempDir });
  } finally {
    cap.restore();
  }
  return { exit, out: cap.out.join(''), err: cap.err.join('') };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-missing-'));
  dataDir = path.join(tempDir, 'plugin-data');
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'missing-' + randomBytes(3).toString('hex');
  runtime.probe = { ok: false, reason: 'not-installed' };
  runtime.calls = [];
  runtime.useRealRun = false;
});

afterEach(() => {
  process.env.PATH = ORIGINAL_ENV.PATH;
  process.env.Path = ORIGINAL_ENV.Path;
  process.env.HOME = ORIGINAL_ENV.HOME;
  process.env.USERPROFILE = ORIGINAL_ENV.USERPROFILE;
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

/** Leave only the directory that holds this Node executable on PATH. */
function keepOnlyNodeOnPath() {
  const nodeDir = path.dirname(process.execPath);
  process.env.PATH = nodeDir;
  process.env.Path = nodeDir;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
}

const AGY_LINE = (verb) =>
  `antigravity:${verb} — \`agy\` is not on PATH (not-installed). Run /antigravity:setup.\n`;

describe('agy missing: one line, exit 1, nothing started', () => {
  const img = () => {
    const p = path.join(tempDir, 'shot.png');
    fs.writeFileSync(p, 'not-a-real-png');
    return p;
  };
  const cases = [
    ['review', () => []],
    ['rescue', () => ['do the thing']],
    ['rescue --background', () => ['do the thing', '--background'], 'rescue'],
    ['task --foreground', () => ['do the thing', '--foreground'], 'task'],
    ['task (background enqueue)', () => ['do the thing'], 'task'],
    ['vision', () => [img(), '--prompt', 'what is this?']],
  ];

  for (const [label, argv, verb = label] of cases) {
    it(`${label}: prints the exact line, no job record, no spawn`, async () => {
      const res = await runVerb(verb, argv());
      assert.equal(res.exit, 1);
      assert.equal(res.err, AGY_LINE(verb));
      assert.equal(res.out, '');
      assert.deepEqual(runtime.calls, [], 'agy must not be spawned');
      assert.deepEqual(dataFiles(), [], 'no job record may be written');
    });
  }

  it('review: the line comes before any diff collection (cwd is not a git repo)', async () => {
    // tempDir has no .git; a diff attempt would print a git failure instead.
    const res = await runVerb('review', ['--scope', 'working-tree']);
    assert.equal(res.exit, 1);
    assert.equal(res.err, AGY_LINE('review'));
  });

  it('--json keeps stdout empty and the message on stderr', async () => {
    const res = await runVerb('task', ['do the thing', '--foreground', '--json']);
    assert.equal(res.exit, 1);
    assert.equal(res.out, '');
    assert.equal(res.err, AGY_LINE('task'));
  });
});

describe('git missing: review prints one plain line', () => {
  it('review: `git is not on PATH (spawnSync git ENOENT).`, exit 1, no job record', async () => {
    runtime.probe = { ok: true, version: 'test' };
    keepOnlyNodeOnPath();
    const res = await runVerb('review', []);
    assert.equal(res.exit, 1);
    assert.equal(res.err, 'antigravity:review — git is not on PATH (spawnSync git ENOENT).\n');
    assert.deepEqual(runtime.calls, []);
    assert.deepEqual(dataFiles(), []);
  });

  it('other git failures keep their text', async () => {
    runtime.probe = { ok: true, version: 'test' };
    try {
      execSync('git --version', { stdio: 'ignore' });
    } catch {
      assert.fail('git is required for this plugin (docs/COMPATIBILITY.md).');
    }
    // A cwd that is not a repository: git runs and exits 128.
    const res = await runVerb('review', ['--scope', 'working-tree']);
    assert.equal(res.exit, 1);
    assert.match(res.err, /^antigravity:review — Command exited with status 128\./);
    assert.doesNotMatch(res.err, /not on PATH/);
  });
});

describe('agy dies on spawn after the probe passed', () => {
  it('task --foreground: `failed: spawn agy ENOENT`, exit 1', async () => {
    runtime.probe = { ok: true, version: 'test' };
    runtime.useRealRun = true;
    keepOnlyNodeOnPath();
    const res = await runVerb('task', ['do the thing', '--foreground']);
    assert.equal(res.exit, 1);
    // Node may emit its ExperimentalWarning through the captured stderr
    // here; the plugin's own first line is the one that starts with the prefix.
    const lines = res.err.split('\n').filter((l) => l.startsWith('antigravity:'));
    assert.equal(lines[0], 'antigravity:task — failed: spawn agy ENOENT');
    assert.match(res.err, /spawn error: spawn agy ENOENT/);
    assert.equal(runtime.calls.length, 1);
  });

  it('a failure with a real agy status keeps `failed (<status>).`', async () => {
    runtime.probe = { ok: true, version: 'test' };
    const { foregroundFailureLine } = await import('../scripts/lib/job-helpers.mjs');
    assert.equal(
      foregroundFailureLine('rescue', { status: 'timeout', spawnError: null }),
      'antigravity:rescue — failed (timeout).',
    );
    assert.equal(
      foregroundFailureLine('rescue', { status: 'failed', spawnError: 'spawn agy ENOENT' }),
      'antigravity:rescue — failed: spawn agy ENOENT',
    );
  });
});
