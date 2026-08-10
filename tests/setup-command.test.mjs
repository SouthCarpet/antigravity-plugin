/**
 * Tests for scripts/commands/setup.mjs — the post-OAuth ensureVisionConfig
 * wiring and --skip-vision flag added for the vision work.
 *
 * agent-runtime.mjs, vision-config.mjs, and node:child_process are all
 * mocked (installed before setup.mjs is imported, following the pattern in
 * tests/job-helpers.test.mjs) so no real `agy` process is spawned and the
 * real `~/.gemini` config is never touched.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

const state = {
  probe: { ok: true, version: '1.1.11' },
  spawnExitCode: 0,
  ensureVisionCalls: [],
  ensureVisionSummary: ['mcp_config.json: already configured', 'settings.json: already configured'],
};

mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    resolveAgyBin: () => 'agy',
    probeAgy: async () => state.probe,
  },
});

mock.module('../scripts/lib/vision-config.mjs', {
  namedExports: {
    ensureVisionConfig: (opts) => {
      state.ensureVisionCalls.push(opts);
      return { summary: state.ensureVisionSummary };
    },
  },
});

mock.module('node:child_process', {
  namedExports: {
    spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', state.spawnExitCode));
      return child;
    },
  },
});

const { run } = await import('../scripts/commands/setup.mjs');

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

beforeEach(() => {
  state.probe = { ok: true, version: '1.1.11' };
  state.spawnExitCode = 0;
  state.ensureVisionCalls = [];
});

describe('/antigravity:setup — vision config wiring', () => {
  it('exits 2 with an install hint when agy is not on PATH, without touching vision config', async () => {
    state.probe = { ok: false, reason: 'not-installed' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], {});
    } finally {
      cap.restore();
    }
    assert.equal(exit, 2);
    assert.match(cap.err.join(''), /not on PATH/);
    assert.equal(state.ensureVisionCalls.length, 0);
  });

  it('returns the OAuth spawn exit code as-is and skips vision config on failure', async () => {
    state.spawnExitCode = 3;
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], {});
    } finally {
      cap.restore();
    }
    assert.equal(exit, 3);
    assert.equal(state.ensureVisionCalls.length, 0);
  });

  it('--skip-vision leaves vision config untouched and exits 0', async () => {
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--skip-vision'], {});
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(state.ensureVisionCalls.length, 0);
    assert.match(cap.out.join(''), /--skip-vision passed/);
  });

  it('calls ensureVisionConfig once after a successful OAuth probe and prints its summary', async () => {
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], {});
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(state.ensureVisionCalls.length, 1);
    const text = cap.out.join('');
    assert.match(text, /mcp_config\.json: already configured/);
    assert.match(text, /settings\.json: already configured/);
  });
});
