/**
 * Regression tests for repeatable options, missing value-option
 * arguments, and conflicting execution flags.
 *
 * Command-level cases mock `agent-runtime.runAgyPrint` so no real `agy`
 * is spawned. Repeatable `--add-dir` is asserted on the `addDirs` array
 * handed to `runAgyPrint` — the boundary where agy argv is built.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { parseArgs } from '../scripts/lib/args.mjs';

const ORIGINAL_ENV = { ...process.env };

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-args-val-'));
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

const REPEATABLE_SCHEMA = {
  valueOptions: ['add-dir', 'cwd'],
  booleanOptions: ['json'],
  repeatableOptions: ['add-dir'],
};

let tempDir;
beforeEach(() => {
  tempDir = makeTempCwd();
  setPluginDataEnv(tempDir);
  agyRuntime.calls = [];
  agyRuntime.next = { status: 'completed', exitCode: 0, stdout: 'ok', stderr: '' };
});
afterEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = ORIGINAL_ENV.CLAUDE_PLUGIN_DATA ?? '';
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.ANTIGRAVITY_PLUGIN_SESSION_ID;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});

describe('parseArgs repeatable options', () => {
  it('accumulates two --add-dir values into an array', () => {
    const out = parseArgs(
      ['--add-dir', 'one', '--add-dir', 'two'],
      REPEATABLE_SCHEMA,
    );
    assert.deepEqual(out.options['add-dir'], ['one', 'two']);
  });

  it('accumulates three --add-dir values into an array', () => {
    const out = parseArgs(
      ['--add-dir', 'one', '--add-dir', 'two', '--add-dir', 'three'],
      REPEATABLE_SCHEMA,
    );
    assert.deepEqual(out.options['add-dir'], ['one', 'two', 'three']);
  });

  it('yields an array even for a single occurrence', () => {
    const out = parseArgs(['--add-dir', 'only'], REPEATABLE_SCHEMA);
    assert.deepEqual(out.options['add-dir'], ['only']);
    assert.equal(Array.isArray(out.options['add-dir']), true);
  });

  it('leaves a repeatable option unset when it is absent', () => {
    const out = parseArgs(['--json'], REPEATABLE_SCHEMA);
    assert.equal(out.options['add-dir'], undefined);
    assert.equal(out.options.json, true);
  });

  it('keeps scalar value options as last-wins strings', () => {
    const out = parseArgs(
      ['--cwd', 'first', '--cwd', 'second'],
      REPEATABLE_SCHEMA,
    );
    assert.equal(out.options.cwd, 'second');
    assert.equal(Array.isArray(out.options.cwd), false);
  });
});

describe('parseArgs missing value options', () => {
  it('throws naming the flag when a value option has no argument', () => {
    assert.throws(
      () => parseArgs(['--prompt'], { valueOptions: ['prompt'] }),
      /missing value for --prompt/,
    );
  });

  it('throws naming the flag when the next token is another flag', () => {
    assert.throws(
      () => parseArgs(['--cwd', '--json'], { valueOptions: ['cwd'], booleanOptions: ['json'] }),
      /missing value for --cwd/,
    );
  });
});

describe('parseArgs conflicting flags', () => {
  const taskSchema = {
    valueOptions: ['conversation', 'cwd', 'add-dir'],
    booleanOptions: ['wait', 'foreground', 'background', 'continue', 'json'],
    repeatableOptions: ['add-dir'],
    conflicts: [
      ['foreground', 'background'],
      ['continue', 'conversation'],
    ],
  };
  const rescueSchema = {
    valueOptions: ['conversation', 'model', 'cwd', 'add-dir'],
    booleanOptions: ['background', 'wait', 'resume', 'continue', 'fresh', 'json'],
    repeatableOptions: ['add-dir'],
    conflicts: [
      ['continue', 'conversation'],
      ['resume', 'conversation'],
      ['fresh', 'resume'],
      ['fresh', 'continue'],
      ['fresh', 'conversation'],
    ],
  };

  it('rejects --foreground with --background', () => {
    assert.throws(
      () => parseArgs(['--foreground', '--background'], taskSchema),
      /cannot combine --foreground and --background/,
    );
  });

  it('rejects --continue with --conversation', () => {
    assert.throws(
      () => parseArgs(['--continue', '--conversation', 'abc'], taskSchema),
      /cannot combine --continue and --conversation/,
    );
  });

  it('rejects --resume with --conversation', () => {
    assert.throws(
      () => parseArgs(['--resume', '--conversation', 'abc'], rescueSchema),
      /cannot combine --resume and --conversation/,
    );
  });

  it('rejects --fresh with --resume', () => {
    assert.throws(
      () => parseArgs(['--fresh', '--resume'], rescueSchema),
      /cannot combine --fresh and --resume/,
    );
  });

  it('rejects --fresh with --continue', () => {
    assert.throws(
      () => parseArgs(['--fresh', '--continue'], rescueSchema),
      /cannot combine --fresh and --continue/,
    );
  });

  it('rejects --fresh with --conversation', () => {
    assert.throws(
      () => parseArgs(['--fresh', '--conversation', 'abc'], rescueSchema),
      /cannot combine --fresh and --conversation/,
    );
  });
});

describe('command: repeated --add-dir reaches runAgyPrint', () => {
  it('rescue passes two --add-dir values through as addDirs', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--add-dir', 'one', '--add-dir', 'two'],
        { cwd: tempDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.equal(agyRuntime.calls.length, 1);
    assert.deepEqual(agyRuntime.calls[0].addDirs, ['one', 'two']);
  });

  it('rescue passes three --add-dir values through as addDirs', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--add-dir', 'one', '--add-dir', 'two', '--add-dir', 'three'],
        { cwd: tempDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.deepEqual(agyRuntime.calls[0].addDirs, ['one', 'two', 'three']);
  });

  it('task --foreground passes a single --add-dir as a one-element array', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--foreground', '--add-dir', 'only'],
        { cwd: tempDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.deepEqual(agyRuntime.calls[0].addDirs, ['only']);
  });
});

describe('command: missing value option', () => {
  it('vision --prompt with no value exits nonzero and names the flag', async () => {
    const img = path.join(tempDir, 'shot.png');
    fs.writeFileSync(img, 'not-a-real-png');
    const { run } = await import('../scripts/commands/vision.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([img, '--prompt'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--prompt/);
  });
});

describe('command: conflicting execution flags', () => {
  it('task --foreground --background exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--foreground', '--background'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--foreground/);
    assert.match(cap.err.join(''), /--background/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('task --continue --conversation exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/task.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--continue', '--conversation', 'abc'],
        { cwd: tempDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--continue/);
    assert.match(cap.err.join(''), /--conversation/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('rescue --resume --conversation exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--resume', '--conversation', 'abc'],
        { cwd: tempDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--resume/);
    assert.match(cap.err.join(''), /--conversation/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('rescue --fresh --resume exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--fresh', '--resume'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--fresh/);
    assert.match(cap.err.join(''), /--resume/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('rescue --fresh --continue exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['do the thing', '--fresh', '--continue'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--fresh/);
    assert.match(cap.err.join(''), /--continue/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('rescue --fresh --conversation exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/rescue.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        ['do the thing', '--fresh', '--conversation', 'abc'],
        { cwd: tempDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--fresh/);
    assert.match(cap.err.join(''), /--conversation/);
    assert.equal(agyRuntime.calls.length, 0);
  });

  it('review --continue --conversation exits nonzero and names both flags', async () => {
    const { run } = await import('../scripts/commands/review.mjs');
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(['--continue', '--conversation', 'abc'], { cwd: tempDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.match(cap.err.join(''), /--continue/);
    assert.match(cap.err.join(''), /--conversation/);
    assert.equal(agyRuntime.calls.length, 0);
  });
});
