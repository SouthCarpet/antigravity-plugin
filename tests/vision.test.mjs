/**
 * Tests for scripts/commands/vision.mjs.
 *
 * Mocks agent-runtime.runAgyPrint (installed before job-helpers/vision are
 * imported, following the pattern in tests/job-helpers.test.mjs) so no real
 * `agy` binary is ever spawned.
 *
 * Note: args.parseCommandInput splits a LONE argv element through the
 * raw-string heuristic (for Claude Code's single-blob $ARGUMENTS) only when
 * it contains whitespace; a lone whitespace-free token — e.g. a bare Windows
 * image path — passes through intact. Regression coverage for that lives in
 * tests/args-lone-element.test.mjs.
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
  tmpDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-vision-cmd-'));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-vision-cmd-data-'));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  imagePath = path.join(tmpDir, 'shot.png');
  fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  delete process.env.CLAUDE_PLUGIN_DATA;
});

describe('/antigravity:vision', () => {
  it('errors when no image path is given', async () => {
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /no image path provided/);
  });

  it('errors naming a missing image path', async () => {
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['definitely-missing.png', '--prompt', 'x'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /image file not found/);
    assert.match(cap.err.join(''), /definitely-missing\.png/);
  });

  it('happy path: returns agy stdout and forwards the default model + built prompt', async () => {
    runtime.calls = [];
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'A red square on a blue background.', stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--prompt', 'what shape is this?'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /red square/);
    assert.equal(runtime.calls.length, 1);
    assert.equal(runtime.calls[0].model, 'gemini-3.6-flash-high');
    assert.match(runtime.calls[0].prompt, /view_image/);
    assert.match(runtime.calls[0].prompt, /what shape is this\?/);
    assert.match(runtime.calls[0].prompt, /VISION-UNAVAILABLE/);
  });

  it('mirrors progress via onText (readable deltas), not raw NDJSON onStdout chunks', async () => {
    runtime.calls = [];
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
    const cap = captureStdio();
    try {
      await run([imagePath, '--prompt', 'x'], { cwd: tmpDir });
      assert.equal(typeof runtime.calls[0].onText, 'function');
      runtime.calls[0].onText('a piece of readable text');
    } finally {
      cap.restore();
    }
    assert.match(cap.err.join(''), /a piece of readable text/);
  });

  it('uses the default description prompt when --prompt is omitted', async () => {
    runtime.calls = [];
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
    const cap = captureStdio();
    try {
      await run([imagePath, '--json'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.match(runtime.calls[0].prompt, /Describe this image in concrete, specific detail/);
  });

  it('honors --model override', async () => {
    runtime.calls = [];
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
    const cap = captureStdio();
    try {
      await run([imagePath, '--model', 'gemini-pro'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(runtime.calls[0].model, 'gemini-pro');
  });

  it('auth_required surfaces the OAuth hint and exits 1', async () => {
    runtime.next = {
      status: 'auth_required',
      exitCode: 1,
      stdout: '',
      stderr: '',
      oauthUrl: 'https://example/oauth',
    };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--prompt', 'x'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /not authenticated/);
    assert.match(cap.err.join(''), /https:\/\/example\/oauth/);
  });

  it('--json emits a structured payload with imagePaths/model/vision', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'described.', stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--json'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.vision, 'described.');
    assert.equal(payload.model, 'gemini-3.6-flash-high');
    assert.deepEqual(payload.imagePaths, [imagePath]);
  });

  it('passes the VISION-UNAVAILABLE sentinel through verbatim', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'VISION-UNAVAILABLE: tool not registered', stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--prompt', 'x'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /VISION-UNAVAILABLE/);
  });

  it('accepts multiple image paths', async () => {
    const second = path.join(tmpDir, 'shot2.png');
    fs.writeFileSync(second, Buffer.from(TINY_PNG_BASE64, 'base64'));
    runtime.calls = [];
    runtime.next = { status: 'completed', exitCode: 0, stdout: 'two images.', stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, second, '--prompt', 'compare these'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(runtime.calls[0].prompt, /2 image/);
  });
});
