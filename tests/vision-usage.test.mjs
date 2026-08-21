/**
 * Tests for the vision command's usage propagation (Task 5):
 * runAgyPrint is invoked with outputFormat: 'json', a successful run with
 * measured usage prints a `usage: total=<N> in=<N> out=<N>` stderr trailer
 * and carries usage/durationSeconds in the --json payload, and a
 * parse-fallback run (usage null/absent) still succeeds with no trailer and
 * payload.usage: null — nothing synthesized.
 *
 * Mocks agent-runtime.runAgyPrint the same way tests/vision.test.mjs does
 * (installed before job-helpers/vision are imported) so no real `agy`
 * binary is ever spawned; this is the authoritative harness pattern for
 * this repo.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMPROOT = os.tmpdir();

const runtime = {
  next: { status: 'completed', exitCode: 0, stdout: '', stderr: '' },
  calls: [],
};

mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      runtime.calls.push(opts);
      return { ...runtime.next };
    },
    spawnAgyDetached: () => ({ pid: 1 }),
    resolveAgyBin: () => 'agy',
    DEFAULT_AGY_BIN: 'agy',
  },
});

const { run } = await import('../scripts/commands/vision.mjs');

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

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let tmpDir;
let dataDir;
let imagePath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-vision-usage-'));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-vision-usage-data-'));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  imagePath = path.join(tmpDir, 'shot.png');
  fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  delete process.env.CLAUDE_PLUGIN_DATA;
});

describe('/antigravity:vision — usage propagation', () => {
  it('invokes the runtime with outputFormat json', async () => {
    runtime.calls = [];
    runtime.next = {
      status: 'completed', exitCode: 0, stdout: 'A red square.', stderr: '',
      usage: { input_tokens: 18351, output_tokens: 28, thinking_tokens: 24, cache_read_tokens: 0, total_tokens: 18379 },
      durationSeconds: 1.73,
    };
    const cap = captureStdio();
    try {
      await run([imagePath, '--prompt', 'what shape is this?'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0].outputFormat, 'json');
  });

  it('prints the usage trailer on stderr for a successful run with measured usage', async () => {
    runtime.calls = [];
    runtime.next = {
      status: 'completed', exitCode: 0, stdout: 'A red square.', stderr: '',
      usage: { input_tokens: 18351, output_tokens: 28, thinking_tokens: 24, cache_read_tokens: 0, total_tokens: 18379 },
      durationSeconds: 1.73,
    };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--prompt', 'what shape is this?'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.err.join(''), /usage: total=18379 in=18351 out=28/);
  });

  it('--json payload carries usage.total_tokens and durationSeconds', async () => {
    runtime.calls = [];
    runtime.next = {
      status: 'completed', exitCode: 0, stdout: 'A red square.', stderr: '',
      usage: { input_tokens: 18351, output_tokens: 28, thinking_tokens: 24, cache_read_tokens: 0, total_tokens: 18379 },
      durationSeconds: 1.73,
    };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--prompt', 'what shape is this?', '--json'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.usage.total_tokens, 18379);
    assert.equal(payload.details.durationSeconds, 1.73);
  });

  it('parse-fallback (usage null): succeeds, payload.usage is null, no trailer', async () => {
    runtime.calls = [];
    runtime.next = {
      status: 'completed', exitCode: 0, stdout: 'not json at all', stderr: '',
      usage: null,
    };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--prompt', 'what shape is this?', '--json'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.doesNotMatch(cap.err.join(''), /usage: total=/);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.usage, null);
  });
});
