/**
 * Tests for scripts/lib/vision-expect.mjs (`vision --expect`, Senate R6,
 * 2026-09).
 *
 * Part 1: unit tests on the parser alone, against three stored answer
 * fixtures. Part 2: end-to-end runs through scripts/commands/vision.mjs with
 * a fake agy (runAgyPrint mocked, following tests/vision.test.mjs's own
 * pattern), whose result carries each fixture as `stdout`, so the real
 * `finishForeground` / envelope path is exercised, not just the parser.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkVisionExpectations,
  formatExpectationsMarkdown,
  validateExpectOption,
  MAX_EXPECT_VALUES,
} from '../scripts/lib/vision-expect.mjs';
import { ArgsError } from '../scripts/lib/args.mjs';

// --- Fixtures -----------------------------------------------------------

const FIXTURE_WITH_TRANSCRIPTION = [
  '## Transcription',
  '### Image 1: shot.png',
  'Welcome to Acme Corp',
  'Open 9am to 5pm',
  '',
  '## Observations',
  'A storefront sign in daylight.',
  '',
  '## Answer',
  'The sign reads "Welcome to Acme Corp".',
].join('\n');

const FIXTURE_NO_HEADING = [
  '## Observations',
  'A storefront sign in daylight.',
  '',
  '## Answer',
  'The sign reads something, but no transcription was produced.',
].join('\n');

const FIXTURE_UNAVAILABLE = 'VISION-UNAVAILABLE: view_image tool not registered';

const EXPECT_VALUES = ['Welcome to Acme Corp', '9am to 5pm', 'Closed on Sundays'];

describe('checkVisionExpectations (unit)', () => {
  it('transcription present: two of three values found', () => {
    const result = checkVisionExpectations(FIXTURE_WITH_TRANSCRIPTION, EXPECT_VALUES);
    assert.equal(result.expectationSummary, 'missing');
    assert.deepEqual(result.expectations, [
      { value: 'Welcome to Acme Corp', found: true },
      { value: '9am to 5pm', found: true },
      { value: 'Closed on Sundays', found: false },
    ]);
  });

  it('no transcription heading: every expectation is unverifiable', () => {
    const result = checkVisionExpectations(FIXTURE_NO_HEADING, EXPECT_VALUES);
    assert.equal(result.expectationSummary, 'unverifiable');
    assert.deepEqual(result.expectations, EXPECT_VALUES.map((value) => (
      { value, found: null, reason: 'no transcription section' }
    )));
  });

  it('single VISION-UNAVAILABLE line: every expectation is unverifiable', () => {
    const result = checkVisionExpectations(FIXTURE_UNAVAILABLE, EXPECT_VALUES);
    assert.equal(result.expectationSummary, 'unverifiable');
    assert.deepEqual(result.expectations, EXPECT_VALUES.map((value) => (
      { value, found: null, reason: 'no transcription section' }
    )));
  });

  it('all values found: summary is all_found', () => {
    const result = checkVisionExpectations(FIXTURE_WITH_TRANSCRIPTION, ['Welcome to Acme Corp', '9am to 5pm']);
    assert.equal(result.expectationSummary, 'all_found');
    assert.ok(result.expectations.every((entry) => entry.found === true));
  });

  it('matches a transcription line exactly only after trimming both sides', () => {
    const answer = ['## Transcription', '  Padded Line  ', '', '## Answer', 'x'].join('\n');
    const result = checkVisionExpectations(answer, ['Padded Line']);
    assert.equal(result.expectations[0].found, true);
  });
});

describe('formatExpectationsMarkdown', () => {
  it('renders one missing line per not-found value', () => {
    const result = checkVisionExpectations(FIXTURE_WITH_TRANSCRIPTION, EXPECT_VALUES);
    assert.equal(
      formatExpectationsMarkdown(result),
      'Expectations: missing\n  missing: Closed on Sundays\n',
    );
  });

  it('renders the single unverifiable line, regardless of value count', () => {
    const result = checkVisionExpectations(FIXTURE_UNAVAILABLE, EXPECT_VALUES);
    assert.equal(
      formatExpectationsMarkdown(result),
      'Expectations: unverifiable\n  unverifiable: no transcription section\n',
    );
  });

  it('renders only the header line when every value is found', () => {
    const result = checkVisionExpectations(FIXTURE_WITH_TRANSCRIPTION, ['Welcome to Acme Corp']);
    assert.equal(formatExpectationsMarkdown(result), 'Expectations: all_found\n');
  });
});

describe('validateExpectOption', () => {
  it('trims every value in place', () => {
    const options = { expect: ['  hello  ', 'world'] };
    validateExpectOption(options);
    assert.deepEqual(options.expect, ['hello', 'world']);
  });

  it('does nothing when --expect is absent', () => {
    const options = {};
    validateExpectOption(options);
    assert.equal(options.expect, undefined);
  });

  it('refuses an empty (or whitespace-only) value', () => {
    assert.throws(() => validateExpectOption({ expect: ['ok', '   '] }), ArgsError);
  });

  it(`refuses more than ${MAX_EXPECT_VALUES} values`, () => {
    const options = { expect: Array.from({ length: MAX_EXPECT_VALUES + 1 }, (_, i) => `v${i}`) };
    assert.throws(() => validateExpectOption(options), ArgsError);
  });

  it(`allows exactly ${MAX_EXPECT_VALUES} values`, () => {
    const options = { expect: Array.from({ length: MAX_EXPECT_VALUES }, (_, i) => `v${i}`) };
    validateExpectOption(options);
    assert.equal(options.expect.length, MAX_EXPECT_VALUES);
  });
});

// --- End-to-end: through vision.mjs with a fake agy ----------------------

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
    resolveAgyBin: () => 'agy',
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});

const { run } = await import('../scripts/commands/vision.mjs');

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

let tmpDir;
let dataDir;
let imagePath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-vision-expect-'));
  dataDir = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-vision-expect-data-'));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  imagePath = path.join(tmpDir, 'shot.png');
  fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, 'base64'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  delete process.env.CLAUDE_PLUGIN_DATA;
});

describe('/antigravity:vision --expect (e2e, fake agy)', () => {
  it('--json: transcription present, two of three found', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_WITH_TRANSCRIPTION, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        [imagePath, '--json', '--expect', 'Welcome to Acme Corp', '--expect', '9am to 5pm', '--expect', 'Closed on Sundays'],
        { cwd: tmpDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.expectationSummary, 'missing');
    assert.deepEqual(payload.details.expectations, [
      { value: 'Welcome to Acme Corp', found: true },
      { value: '9am to 5pm', found: true },
      { value: 'Closed on Sundays', found: false },
    ]);
  });

  it('markdown: transcription present, two of three found', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_WITH_TRANSCRIPTION, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(
        [imagePath, '--expect', 'Welcome to Acme Corp', '--expect', '9am to 5pm', '--expect', 'Closed on Sundays'],
        { cwd: tmpDir },
      );
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const stdout = cap.out.join('');
    assert.match(stdout, /Welcome to Acme Corp/); // the answer itself still prints
    assert.match(stdout, /Expectations: missing\n {2}missing: Closed on Sundays\n/);
  });

  it('--json: no transcription heading is unverifiable', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_NO_HEADING, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--json', '--expect', 'anything'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.expectationSummary, 'unverifiable');
    assert.deepEqual(payload.details.expectations, [
      { value: 'anything', found: null, reason: 'no transcription section' },
    ]);
  });

  it('markdown: no transcription heading is unverifiable', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_NO_HEADING, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--expect', 'anything'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    assert.match(cap.out.join(''), /Expectations: unverifiable\n {2}unverifiable: no transcription section\n/);
  });

  it('--json: single VISION-UNAVAILABLE line is unverifiable', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_UNAVAILABLE, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--json', '--expect', 'anything'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal(payload.details.expectationSummary, 'unverifiable');
    assert.equal(payload.answer, FIXTURE_UNAVAILABLE);
  });

  it('markdown: single VISION-UNAVAILABLE line is unverifiable', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_UNAVAILABLE, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--expect', 'anything'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const stdout = cap.out.join('');
    assert.match(stdout, /VISION-UNAVAILABLE/);
    assert.match(stdout, /Expectations: unverifiable\n {2}unverifiable: no transcription section\n/);
  });

  it('exit code is unaffected by --expect, missing or not', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_WITH_TRANSCRIPTION, stderr: '' };
    const cap1 = captureStdio();
    let withoutExpect;
    try {
      withoutExpect = await run([imagePath], { cwd: tmpDir });
    } finally {
      cap1.restore();
    }
    const cap2 = captureStdio();
    let withExpect;
    try {
      withExpect = await run([imagePath, '--expect', 'Closed on Sundays'], { cwd: tmpDir });
    } finally {
      cap2.restore();
    }
    assert.equal(withoutExpect, withExpect);
  });

  it('no --expect: no expectations field at all, and no markdown block', async () => {
    runtime.next = { status: 'completed', exitCode: 0, stdout: FIXTURE_WITH_TRANSCRIPTION, stderr: '' };
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--json'], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 0);
    const payload = JSON.parse(cap.out.join(''));
    assert.equal('expectations' in payload.details, false);
    assert.equal('expectationSummary' in payload.details, false);
  });

  it('refuses an empty --expect value (stderr only, exit 1)', async () => {
    const cap = captureStdio();
    let exit;
    try {
      exit = await run([imagePath, '--expect', '   '], { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.match(cap.err.join(''), /invalid value for --expect/);
  });

  it('refuses more than 32 --expect values (stderr only, exit 1)', async () => {
    const argv = [imagePath];
    for (let i = 0; i < MAX_EXPECT_VALUES + 1; i += 1) argv.push('--expect', `v${i}`);
    const cap = captureStdio();
    let exit;
    try {
      exit = await run(argv, { cwd: tmpDir });
    } finally {
      cap.restore();
    }
    assert.equal(exit, 1);
    assert.equal(cap.out.join(''), '');
    assert.match(cap.err.join(''), /invalid value for --expect/);
  });
});
