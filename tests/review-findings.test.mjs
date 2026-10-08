/**
 * `review --findings-json` (Senate R7, 2026-09): opt-in structured review
 * findings. agy 1.2.12 accepts `--json-schema <path>` with the stream-json
 * transport and puts a `structured_output` field on its final `result`
 * event (measured in agy-1.2.12-20260927/probe-json-schema.txt). The plugin
 * validates that field locally against the schema file it ships; `answer`
 * stays agy's raw response text in every case.
 *
 * Three layers:
 *   - the validator itself (every bound, every enum, extra keys);
 *   - the full agy argv with and without the flag (real fake-agy spawns
 *     through bin/antigravity.mjs);
 *   - the five `result` event shapes (valid, extra key, wrong enum,
 *     non-JSON string, absent) on the foreground path, the background path
 *     read back through `result <id> --json`, and the worker's stored-request
 *     revalidation.
 *
 *   node --test tests/review-findings.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';
import {
  REVIEW_FINDINGS_SCHEMA_PATH,
  SUPPORTED_SCHEMA_KEYWORDS,
  validateReviewFindings,
} from '../scripts/lib/review-findings.mjs';
import { buildReviewInput } from '../scripts/lib/review-input.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO_ROOT, 'bin', 'antigravity.mjs');
const SCHEMA_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'review-findings.schema.json');
const TMPROOT = portableTmpRoot();

const DEFAULT_BUDGET_ARGV_TAIL = [
  '--print-timeout', '1860s',
  '--disable-slash-commands',
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '',
];

const SCHEMA_SENTENCE = 'The structured result must follow the JSON schema supplied with this run.';

function finding(overrides = {}) {
  return {
    severity: 'high',
    file: 'src/app.js',
    line: 12,
    description: 'Unchecked null.',
    recommendation: 'Guard the value.',
    ...overrides,
  };
}

function validFindings(overrides = {}) {
  return {
    verdict: 'CHANGES_REQUESTED',
    summary: 'One real bug.',
    findings: [finding()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe('review-findings.schema.json — the shipped schema', () => {
  it('is exactly the documented schema', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const text = (max) => ({ type: 'string', maxLength: max });
    assert.deepEqual(schema, {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['APPROVE', 'CHANGES_REQUESTED', 'NEEDS_DISCUSSION'] },
        summary: text(2000),
        findings: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'nit'] },
              file: text(2000),
              line: { type: ['integer', 'null'] },
              description: text(2000),
              recommendation: text(2000),
            },
            required: ['severity', 'file', 'line', 'description', 'recommendation'],
            additionalProperties: false,
          },
        },
      },
      required: ['verdict', 'summary', 'findings'],
      additionalProperties: false,
    });
  });

  it('REVIEW_FINDINGS_SCHEMA_PATH is the absolute path of the shipped file', () => {
    assert.ok(path.isAbsolute(REVIEW_FINDINGS_SCHEMA_PATH));
    assert.equal(path.resolve(REVIEW_FINDINGS_SCHEMA_PATH), path.resolve(SCHEMA_PATH));
  });

  it('uses only keywords the local validator implements', () => {
    const seen = new Set();
    const walk = (node) => {
      for (const [key, value] of Object.entries(node)) {
        seen.add(key);
        if (key === 'properties') Object.values(value).forEach(walk);
        if (key === 'items') walk(value);
      }
    };
    walk(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
    for (const key of seen) assert.ok(SUPPORTED_SCHEMA_KEYWORDS.includes(key), `unsupported keyword ${key}`);
  });
});

describe('validateReviewFindings', () => {
  it('accepts a valid object and returns it as findings', () => {
    const value = validFindings();
    assert.deepEqual(validateReviewFindings(value), { status: 'valid', findings: value, error: null });
  });

  it('accepts the same object as JSON text (the stored structuredRaw form)', () => {
    const value = validFindings();
    assert.deepEqual(validateReviewFindings(JSON.stringify(value)), { status: 'valid', findings: value, error: null });
  });

  it('accepts line: null, an empty findings list, and every verdict and severity', () => {
    for (const verdict of ['APPROVE', 'CHANGES_REQUESTED', 'NEEDS_DISCUSSION']) {
      assert.equal(validateReviewFindings(validFindings({ verdict, findings: [] })).status, 'valid');
    }
    for (const severity of ['critical', 'high', 'medium', 'low', 'nit']) {
      assert.equal(validateReviewFindings(validFindings({ findings: [finding({ severity, line: null })] })).status, 'valid');
    }
  });

  it('null and undefined are missing', () => {
    for (const raw of [null, undefined]) {
      const out = validateReviewFindings(raw);
      assert.equal(out.status, 'missing');
      assert.equal(out.findings, null);
      assert.equal(out.error, 'agy returned no structured output');
    }
  });

  const invalidCases = [
    ['a non-JSON string', 'not json {', 'structured output is not valid JSON'],
    ['a JSON array at the top level', [], 'result: expected object, got array'],
    ['an extra top-level key', validFindings({ toolAction: 'Finishing task' }), 'result: unexpected key "toolAction"'],
    ['an extra key in a finding', validFindings({ findings: [{ ...finding(), extra: 1 }] }), 'result.findings[0]: unexpected key "extra"'],
    ['a missing required key', (() => { const v = validFindings(); delete v.summary; return v; })(), 'result: missing required key "summary"'],
    ['a missing finding key', validFindings({ findings: [(() => { const f = finding(); delete f.line; return f; })()] }), 'result.findings[0]: missing required key "line"'],
    ['a wrong verdict enum', validFindings({ verdict: 'LGTM' }), 'result.verdict: must be one of APPROVE, CHANGES_REQUESTED, NEEDS_DISCUSSION'],
    ['a wrong severity enum', validFindings({ findings: [finding({ severity: 'blocker' })] }), 'result.findings[0].severity: must be one of critical, high, medium, low, nit'],
    ['line as a string', validFindings({ findings: [finding({ line: '12' })] }), 'result.findings[0].line: expected integer or null, got string'],
    ['line as a fraction', validFindings({ findings: [finding({ line: 1.5 })] }), 'result.findings[0].line: expected integer or null, got number'],
    ['201 findings', validFindings({ findings: Array.from({ length: 201 }, () => finding()) }), 'result.findings: more than 200 items'],
    ['a 2001-char summary', validFindings({ summary: 'x'.repeat(2001) }), 'result.summary: longer than 2000 characters'],
    ['a 2001-char recommendation', validFindings({ findings: [finding({ recommendation: 'y'.repeat(2001) })] }), 'result.findings[0].recommendation: longer than 2000 characters'],
  ];
  for (const [label, raw, error] of invalidCases) {
    it(`${label} is invalid with a one-line error`, () => {
      assert.deepEqual(validateReviewFindings(raw), { status: 'invalid', findings: null, error });
    });
  }

  it('the exact bounds pass: 200 findings, 2000-char strings', () => {
    const long = 'z'.repeat(2000);
    const value = validFindings({
      summary: long,
      findings: Array.from({ length: 200 }, () => finding({ file: long, description: long, recommendation: long })),
    });
    assert.equal(validateReviewFindings(value).status, 'valid');
  });

  it('an echoed hostile key cannot break the error onto a second line', () => {
    const out = validateReviewFindings({ ...validFindings(), 'evil\nkey\r': 1 });
    assert.equal(out.status, 'invalid');
    assert.doesNotMatch(out.error, /[\r\n]/);
  });
});

describe('buildReviewInput — findingsJson adds one Output sentence', () => {
  const ENVELOPE = {
    scope: 'working-tree',
    context: { summary: '1 file changed', diff: 'diff --git a/x.js b/x.js\n+console.log(1);\n' },
  };

  it('without the option the prompt is unchanged and carries no schema sentence', () => {
    const plain = buildReviewInput(ENVELOPE, {});
    assert.equal(plain.prompt, buildReviewInput(ENVELOPE).prompt);
    assert.equal(plain.prompt.includes(SCHEMA_SENTENCE), false);
  });

  it('with findingsJson the Output section ends with the schema sentence', () => {
    const plain = buildReviewInput(ENVELOPE, {});
    const withFlag = buildReviewInput(ENVELOPE, { findingsJson: true });
    assert.equal(withFlag.prompt, `${plain.prompt}\n${SCHEMA_SENTENCE}`);
    assert.notEqual(withFlag.inputHash, plain.inputHash);
  });
});

// ---------------------------------------------------------------------------
// Real runs through bin/antigravity.mjs with a fake agy
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
};

const RESPONSE_TEXT = '{"verdict":"APPROVE","summary":"ok","findings":[],"toolAction":"Finishing task"}\n';

function resultEvent(structuredOutput) {
  const result = { status: 'SUCCESS', response: RESPONSE_TEXT };
  if (structuredOutput !== undefined) result.structured_output = structuredOutput;
  return `${JSON.stringify({ event: 'result', result })}\n`;
}

const FIXTURES = {
  valid: validFindings(),
  extraKey: validFindings({ toolAction: 'Finishing task' }),
  wrongEnum: validFindings({ verdict: 'LGTM' }),
  nonJson: 'not json {',
  absent: undefined,
};

let stubDir;
let echoAgy;
const fakes = {};
const cleanup = [];

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-findings-'));
  echoAgy = writeFakeAgy(stubDir, 'agy-echo', { echoArgsStderr: true, exitCode: 1, versionOk: true });
  for (const [name, structured] of Object.entries(FIXTURES)) {
    fakes[name] = writeFakeAgy(stubDir, `agy-${name}`, {
      stdout: resultEvent(structured), echoArgsStderr: true, exitCode: 0, versionOk: true,
    });
  }
});

after(() => {
  for (const dir of [stubDir, ...cleanup]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function freshRepo() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-findings-work-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-findings-data-'));
  cleanup.push(work, data);
  execSync('git init -q', { cwd: work, stdio: 'ignore', env: GIT_ENV });
  execSync('git commit --allow-empty -q -m init', { cwd: work, stdio: 'ignore', env: GIT_ENV });
  fs.writeFileSync(path.join(work, 'brand-new.txt'), 'never committed\n');
  return { work, data };
}

function envFor(agyBin, data) {
  return {
    ...process.env,
    AGY_BIN: agyBin,
    CLAUDE_PLUGIN_DATA: data,
    ANTIGRAVITY_PLUGIN_SESSION_ID: 'findings-' + randomBytes(3).toString('hex'),
  };
}

function runVerb(args, env, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

function argvOf(stderr) {
  return String(stderr)
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, ''))
    .filter((l) => l.startsWith('arg='))
    .map((l) => l.slice(4));
}

function warningLines(stderr) {
  return String(stderr).split(/\r?\n/).filter((l) => l.startsWith('antigravity:review — warning: structured findings'));
}

function readStoredJob(data, jobId) {
  const records = fs.readdirSync(data, { recursive: true }).filter((file) => file.endsWith(jobId + '.json'));
  assert.equal(records.length, 1);
  return JSON.parse(fs.readFileSync(path.join(data, records[0]), 'utf8'));
}

describe('review --findings-json: full agy argv', () => {
  it('without the flag the argv is byte-identical to before', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review'], envFor(echoAgy, data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(argvOf(res.stderr), [...DEFAULT_BUDGET_ARGV_TAIL]);
  });

  it('with the flag --json-schema <abs path> sits immediately before --print-timeout', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review', '--findings-json'], envFor(echoAgy, data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(argvOf(res.stderr), ['--json-schema', SCHEMA_PATH, ...DEFAULT_BUDGET_ARGV_TAIL]);
  });

  it('with --model and --effort too: model, effort, then --json-schema, then the tail', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review', '--model', 'gemini-x', '--effort', 'low', '--findings-json'], envFor(echoAgy, data), work);
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(
      argvOf(res.stderr),
      ['--model', 'gemini-x', '--effort', 'low', '--json-schema', SCHEMA_PATH, ...DEFAULT_BUDGET_ARGV_TAIL],
    );
  });

  it('background: the stored request carries findingsJson and the worker argv carries --json-schema', () => {
    const { work, data } = freshRepo();
    const env = envFor(echoAgy, data);
    const queued = runVerb(['review', '--findings-json', '--background', '--wait', '--json'], env, work);
    assert.equal(queued.status, 1, queued.stderr);
    const { jobId } = JSON.parse(queued.stdout);
    const stored = readStoredJob(data, jobId);
    assert.equal(stored.request.findingsJson, true);
    assert.deepEqual(argvOf(stored.result.stderr), ['--json-schema', SCHEMA_PATH, ...DEFAULT_BUDGET_ARGV_TAIL]);
  });

  it('background without the flag stores no findingsJson field', () => {
    const { work, data } = freshRepo();
    const env = envFor(echoAgy, data);
    const queued = runVerb(['review', '--background', '--wait', '--json'], env, work);
    const { jobId } = JSON.parse(queued.stdout);
    assert.equal('findingsJson' in readStoredJob(data, jobId).request, false);
  });
});

const EXPECTED = {
  valid: { findingsStatus: 'valid', findings: FIXTURES.valid, findingsError: undefined },
  extraKey: { findingsStatus: 'invalid', findings: null, findingsError: 'result: unexpected key "toolAction"' },
  wrongEnum: {
    findingsStatus: 'invalid', findings: null,
    findingsError: 'result.verdict: must be one of APPROVE, CHANGES_REQUESTED, NEEDS_DISCUSSION',
  },
  nonJson: { findingsStatus: 'invalid', findings: null, findingsError: 'structured output is not valid JSON' },
  absent: { findingsStatus: 'missing', findings: null, findingsError: 'agy returned no structured output' },
};

function assertFindingsDetails(details, expected) {
  assert.equal(details.findingsStatus, expected.findingsStatus);
  assert.deepEqual(details.findings, expected.findings);
  assert.equal(details.findingsError, expected.findingsError);
  if (expected.findingsError === undefined) assert.equal('findingsError' in details, false);
}

describe('review --findings-json --json (foreground): five result event shapes', () => {
  for (const name of Object.keys(FIXTURES)) {
    it(`${name}: findings fields as expected, answer is the raw response, exit 0`, () => {
      const { work, data } = freshRepo();
      const res = runVerb(['review', '--findings-json', '--json'], envFor(fakes[name], data), work);
      assert.equal(res.status, 0, res.stderr);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.status, 'completed');
      assert.equal(payload.answer, RESPONSE_TEXT);
      assertFindingsDetails(payload.details, EXPECTED[name]);
      const warnings = warningLines(res.stderr);
      if (name === 'valid') {
        assert.deepEqual(warnings, []);
      } else {
        assert.deepEqual(warnings, [
          `antigravity:review — warning: structured findings ${EXPECTED[name].findingsStatus}: ${EXPECTED[name].findingsError}`,
        ]);
      }
    });
  }

  it('without the flag the same valid event adds no findings fields to details', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review', '--json'], envFor(fakes.valid, data), work);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.answer, RESPONSE_TEXT);
    for (const key of ['findings', 'findingsStatus', 'findingsError']) assert.equal(key in payload.details, false, key);
    assert.deepEqual(warningLines(res.stderr), []);
  });

  it('text mode: stdout is the raw response, the warning goes to stderr', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review', '--findings-json'], envFor(fakes.wrongEnum, data), work);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.startsWith(RESPONSE_TEXT.trimEnd()), true, res.stdout);
    assert.equal(warningLines(res.stderr).length, 1);
  });
});

describe('review --findings-json --background: result <id> reads the stored record', () => {
  for (const name of ['valid', 'extraKey', 'nonJson', 'absent']) {
    it(`${name}: result <id> --json exposes the three fields; structuredRaw is stored`, () => {
      const { work, data } = freshRepo();
      const env = envFor(fakes[name], data);
      const queued = runVerb(['review', '--findings-json', '--background', '--wait', '--json'], env, work);
      assert.equal(queued.status, 0, queued.stderr);
      const { jobId } = JSON.parse(queued.stdout);

      const res = runVerb(['result', jobId, '--json'], env, work);
      assert.equal(res.status, 0, res.stderr);
      const payload = JSON.parse(res.stdout);
      assert.equal(payload.answer, RESPONSE_TEXT);
      assertFindingsDetails(payload.details, EXPECTED[name]);

      const structured = FIXTURES[name];
      const expectedRaw = structured === undefined ? null
        : typeof structured === 'string' ? structured : JSON.stringify(structured);
      assert.equal(payload.details.result.structuredRaw, expectedRaw);

      const text = runVerb(['result', jobId], env, work);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, new RegExp(`^Findings: ${EXPECTED[name].findingsStatus}$`, 'm'));
    });
  }

  it('--wait --show-result --json carries the same fields and one warning line', () => {
    const { work, data } = freshRepo();
    const env = envFor(fakes.wrongEnum, data);
    const res = runVerb(['review', '--findings-json', '--background', '--wait', '--show-result', '--json'], env, work);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.answer, RESPONSE_TEXT);
    assertFindingsDetails(payload.details, EXPECTED.wrongEnum);
    assert.equal(warningLines(res.stderr).length, 1);
  });

  it('a background job without the flag: result <id> has no findings fields and no Findings line', () => {
    const { work, data } = freshRepo();
    const env = envFor(fakes.valid, data);
    const queued = runVerb(['review', '--background', '--wait', '--json'], env, work);
    const { jobId } = JSON.parse(queued.stdout);
    const payload = JSON.parse(runVerb(['result', jobId, '--json'], env, work).stdout);
    for (const key of ['findings', 'findingsStatus', 'findingsError']) assert.equal(key in payload.details, false, key);
    assert.doesNotMatch(runVerb(['result', jobId], env, work).stdout, /^Findings:/m);
  });
});

// ---------------------------------------------------------------------------
// A run that does not complete reports no findings (3.0.0, O4 gap)
// ---------------------------------------------------------------------------

describe('review --findings-json: a run that ends in result ERROR carries no findings fields', () => {
  const REASON = 'API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server';
  let erroredAgy;

  before(() => {
    const line = JSON.stringify({
      event: 'result',
      // A valid structured_output beside status ERROR must not be reported as findings.
      result: { status: 'ERROR', response: '', error: REASON, structured_output: validFindings() },
    });
    erroredAgy = writeFakeAgy(stubDir, 'agy-errored', { stdout: `${line}
`, exitCode: 1, versionOk: true });
  });

  it('foreground --json: failed, the reason is the message, no findings keys', () => {
    const { work, data } = freshRepo();
    const res = runVerb(['review', '--findings-json', '--json'], envFor(erroredAgy, data), work);
    assert.equal(res.status, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'failed');
    assert.equal(payload.answer, null);
    assert.equal(payload.details.error.code, 'run_failed');
    assert.equal(payload.details.error.message, REASON);
    for (const key of ['findings', 'findingsStatus', 'findingsError']) assert.equal(key in payload.details, false, key);
    assert.deepEqual(warningLines(res.stderr), []);
  });

  it('background then result --json: job_failed, the same reason, no findings keys', () => {
    const { work, data } = freshRepo();
    const env = envFor(erroredAgy, data);
    const queued = runVerb(['review', '--findings-json', '--background', '--wait', '--json'], env, work);
    const { jobId } = JSON.parse(queued.stdout);
    const res = runVerb(['result', jobId, '--json'], env, work);
    assert.equal(res.status, 1, res.stderr);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.status, 'failed');
    assert.equal(payload.details.error.code, 'job_failed');
    assert.equal(payload.details.error.message, REASON);
    for (const key of ['findings', 'findingsStatus', 'findingsError']) assert.equal(key in payload.details, false, key);
    assert.doesNotMatch(runVerb(['result', jobId], env, work).stdout, /^Findings:/m);
  });
});

// ---------------------------------------------------------------------------
// Worker revalidation of a stored findingsJson
// ---------------------------------------------------------------------------

describe('worker persisted-request findingsJson revalidation', () => {
  const cases = [
    { findingsJson: 'yes', echoed: 'yes' },
    { findingsJson: 1, echoed: '1' },
    { findingsJson: 'tr\x00ue\x1f', echoed: 'true' },
  ];
  for (const { findingsJson, echoed } of cases) {
    it('fails stored findingsJson ' + JSON.stringify(findingsJson) + ' before agy spawns', () => {
      const workspace = fs.mkdtempSync(path.join(TMPROOT, 'antigravity-worker-findings-reject-'));
      const data = path.join(workspace, 'data');
      const script = `
        import { mock } from 'node:test';
        const state = await import(${JSON.stringify(new URL('../scripts/lib/state.mjs', import.meta.url).href)});
        let spawns = 0;
        mock.module(${JSON.stringify(new URL('../scripts/lib/process-adapter.mjs', import.meta.url).href)}, {
          namedExports: { spawn() { spawns++; throw new Error('unexpected agy spawn'); } },
        });
        const workspace = process.cwd();
        const jobId = 'stored-request';
        state.ensureStateDir(workspace);
        await state.upsertJob(workspace, { id: jobId, kind: 'review', status: 'queued' });
        await state.writeJobFile(workspace, jobId, {
          id: jobId, kind: 'review', status: 'queued',
          request: { prompt: 'hello', findingsJson: ${JSON.stringify(findingsJson)} },
        });
        process.argv[2] = jobId;
        process.on('exit', () => {
          process.stdout.write(JSON.stringify({ spawns, stored: state.readJobFile(workspace, jobId) }));
        });
        await import(${JSON.stringify(new URL('../scripts/commands/_worker.mjs', import.meta.url).href)});
      `;
      try {
        const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', '--input-type=module', '-e', script], {
          encoding: 'utf8', cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
        });
        assert.equal(result.status, 1, result.stderr);
        const { stored, spawns } = JSON.parse(result.stdout);
        assert.equal(spawns, 0);
        assert.equal(stored.status, 'failed');
        assert.equal(stored.healthStatus, 'failed');
        assert.equal(stored.errorMessage, 'stored request carries an unsupported findingsJson: ' + echoed);
      } finally { removeTestDir(workspace); }
    });
  }
});
