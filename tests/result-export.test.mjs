/**
 * `result <job-id> --export <path>` (3.2.0, package C, item C3).
 *
 * The exported file is the plain `result <job-id> --json` text of the job:
 * the stored record in its safe, redacted shape, uncut, written to a NEW
 * file that is never overwritten.
 *
 *   node --test --experimental-test-module-mocks tests/result-export.test.mjs
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { captureStdio } from './helpers/capture-stdio.mjs';
import { upsertJob, writeJobFile } from '../scripts/lib/state.mjs';
import { OAUTH_URL_MARKER } from '../scripts/lib/safe-reason.mjs';
import { resetWorkspaceRootCache } from '../scripts/lib/workspace.mjs';
import { run } from '../scripts/commands/result.mjs';

const saved = { data: process.env.CLAUDE_PLUGIN_DATA, session: process.env.ANTIGRAVITY_PLUGIN_SESSION_ID };
let dir;

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'result-export-')));
  process.env.CLAUDE_PLUGIN_DATA = path.join(dir, 'data');
  process.env.ANTIGRAVITY_PLUGIN_SESSION_ID = 'export-session';
  resetWorkspaceRootCache();
});
afterEach(() => {
  for (const [key, value] of [['CLAUDE_PLUGIN_DATA', saved.data], ['ANTIGRAVITY_PLUGIN_SESSION_ID', saved.session]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

async function go(args, ctx = {}) {
  const cap = captureStdio();
  let code;
  try {
    code = await run(args, { cwd: dir, ...ctx });
  } finally {
    cap.restore();
  }
  return { code, out: cap.out.join(''), err: cap.err.join('') };
}

const ANSWER = 'line one\nline two\nline three';
let counter = 0;
async function makeJob(kind, { status = 'completed', rawOutput = ANSWER, request = {}, extra = {} } = {}) {
  counter += 1;
  const id = `${String(counter).padStart(2, '0')}abcdef1234`;
  await upsertJob(dir, { id, kind, status, title: `${kind} job` });
  await writeJobFile(dir, id, {
    id, kind, status, title: `${kind} job`, request,
    provenance: { pluginVersion: '3.1.0', agyVersion: '1.5.1', model: null, effort: null, mode: 'print', addDirCount: 0, requestedAt: '2026-11-09T10:00:00.000Z' },
    result: { rawOutput, stderr: '', status, exitCode: status === 'completed' ? 0 : 1, usage: { total_tokens: 12, input_tokens: 10, output_tokens: 2 }, durationSeconds: 3 },
    ...extra,
  });
  return id;
}

const file = (name) => path.join(dir, name);
const plainJson = async (id) => (await go([id, '--json'])).out;

// Oracle: ruling 4. The file is the text `result <id> --json` prints with no other flag.
describe('file content', () => {
  for (const kind of ['review', 'task', 'rescue', 'vision', 'media']) {
    test(`the file equals the result --json output of a ${kind} job, byte for byte`, async () => {
      const id = await makeJob(kind, { request: kind === 'review' ? { scope: 'working-tree', base: null, inputHash: 'abc', hunks: [] } : {} });
      const expected = await plainJson(id);
      assert.ok(expected.endsWith('}\n'));
      const r = await go([id, '--export', 'job.json']);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(fs.readFileSync(file('job.json')), Buffer.from(expected, 'utf8'));
    });
  }

  for (const status of ['failed', 'cancelled']) {
    test(`a ${status} job is exported with its own envelope`, async () => {
      const id = await makeJob('task', { status });
      const expected = await plainJson(id);
      await go([id, '--export', 'job.json']);
      assert.equal(fs.readFileSync(file('job.json'), 'utf8'), expected);
      assert.equal(JSON.parse(expected).status, status);
    });
  }

  test('--head, --tail and both checks change what the call prints, never the file', async () => {
    const id = await makeJob('review', { request: { scope: 'working-tree', base: null, inputHash: 'abc', hunks: [{ path: 'a.txt', newStart: 1, newEnd: 3 }] } });
    const expected = await plainJson(id);
    const flagSets = [['--head', '1'], ['--tail', '1'], ['--head', '1', '--tail', '1'], ['--check-locations'], ['--check-current'], ['--head', '1', '--check-locations', '--check-current']];
    for (const [index, flags] of flagSets.entries()) {
      const name = `cut-${index}.json`;
      const r = await go([id, '--export', name, '--json', ...flags]);
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.readFileSync(file(name), 'utf8'), expected, flags.join(' '));
      const printed = JSON.parse(r.out);
      if (flags.includes('--head') || flags.includes('--tail')) {
        assert.equal(printed.details.truncated, true);
        assert.notEqual(printed.answer, JSON.parse(expected).answer);
      }
    }
  });

  test('the file never carries truncated, locationCheck, checkCurrent or exported', async () => {
    const id = await makeJob('review', { request: { scope: 'working-tree', base: null, inputHash: 'abc', hunks: [] } });
    await go([id, '--export', 'job.json', '--head', '1', '--check-locations', '--check-current']);
    const { details } = JSON.parse(fs.readFileSync(file('job.json'), 'utf8'));
    for (const key of ['truncated', 'locationCheck', 'checkCurrent', 'exported']) assert.equal(key in details, false, key);
  });

  test('the file ends with exactly one newline and has no byte order mark', async () => {
    const id = await makeJob('task');
    await go([id, '--export', 'job.json']);
    const bytes = fs.readFileSync(file('job.json'));
    assert.equal(bytes.at(-1), 0x0a);
    assert.notEqual(bytes.at(-2), 0x0a);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  test('an OAuth URL in a stored answer is redacted in the file', async () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=attacker&redirect_uri=https%3A%2F%2Fevil.test';
    const id = await makeJob('task', { rawOutput: `Sign in at ${url} now` });
    await go([id, '--export', 'job.json']);
    const content = fs.readFileSync(file('job.json'), 'utf8');
    assert.doesNotMatch(content, /accounts\.google\.com\/o\/oauth2/);
    assert.ok(content.includes(OAUTH_URL_MARKER));
    assert.equal(content, await plainJson(id));
  });
});

describe('what the call prints', () => {
  test('--json adds details.exported with the path and the byte count', async () => {
    const id = await makeJob('task');
    const r = await go([id, '--export', 'job.json', '--json']);
    assert.equal(r.code, 0, r.err);
    const { details } = JSON.parse(r.out);
    assert.deepEqual(details.exported, { path: file('job.json'), bytes: fs.statSync(file('job.json')).size });
    assert.deepEqual(Object.keys(details).at(-1), 'exported');
  });

  test('text mode prints the answer as before and one last Exported line', async () => {
    const id = await makeJob('task');
    const plain = await go([id]);
    const r = await go([id, '--export', 'job.json']);
    assert.equal(r.out, `${plain.out}Exported: ${file('job.json')}\n`);
  });

  test('without the flag the output is unchanged: no exported key', async () => {
    const id = await makeJob('task');
    assert.equal('exported' in JSON.parse(await plainJson(id)).details, false);
  });

  test('a relative path is resolved against --cwd, not the process directory', async () => {
    const id = await makeJob('task');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const r = await go([id, '--export', 'rel.json', '--cwd', dir, '--json'], { cwd: sub });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(file('rel.json')), true);
    assert.equal(fs.existsSync(path.join(sub, 'rel.json')), false);
    assert.equal(JSON.parse(r.out).details.exported.path, file('rel.json'));
  });

  test('a path with a backtick is shown with the display sanitizer and still written', async () => {
    const id = await makeJob('task');
    const r = await go([id, '--export', 'a`b.json', '--json']);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(file('a`b.json')), true);
    assert.equal(JSON.parse(r.out).details.exported.path, file("a'b.json"));
  });
});

// Oracle: ruling 5. Never overwrites; every refusal is invalid_input / export_target_unwritable and writes nothing.
describe('target refusals', () => {
  function makeTargets() {
    const targets = {};
    fs.writeFileSync(file('exists.json'), 'original');
    targets.file = ['exists.json', /^Export target already exists as a file: /];
    fs.mkdirSync(file('folder'));
    targets.directory = ['folder', /^Export target already exists as a directory: /];
    fs.writeFileSync(file('readonly.json'), 'original');
    fs.chmodSync(file('readonly.json'), 0o444);
    targets.readOnly = ['readonly.json', /^Export target already exists as a file: /];
    targets.missingParent = [path.join('missing', 'job.json'), /^Export target directory does not exist: /];
    targets.empty = ['', /^Export path is empty\./];
    targets.control = ['bad\nname.json', /^Export path holds a control character \(shown escaped\): bad\\nname\.json$/];
    targets.tooLong = ['x'.repeat(5000), /^Export path is longer than the \d+ characters this platform allows\.$/];
    fs.mkdirSync(file('real-dir'));
    try {
      fs.symlinkSync(file('real-dir'), file('link'), 'junction');
      targets.link = ['link', /^Export target already exists as a link: /];
    } catch { /* links are not available here */ }
    return targets;
  }

  test('each refused target gives invalid_input, exit 1, nothing on stdout in text mode and no change on disk', async () => {
    const id = await makeJob('task');
    const targets = makeTargets();
    const listing = fs.readdirSync(dir).sort();
    for (const [name, [value, message]] of Object.entries(targets)) {
      const text = await go([id, '--export', value]);
      assert.equal(text.code, 1, name);
      assert.equal(text.out, '', name);
      const line = text.err.split('\n').find((candidate) => candidate.startsWith('antigravity:result — '));
      assert.match(line.slice('antigravity:result — '.length), message, name);
      assert.doesNotMatch(text.err, /[\u0000-\u0009\u000b-\u001f\u007f]/, `${name}: raw control character on stderr`);

      const json = await go([id, '--export', value, '--json']);
      assert.equal(json.code, 1, name);
      const payload = JSON.parse(json.out);
      assert.equal(payload.status, 'invalid_input');
      assert.equal(payload.jobId, id);
      assert.equal(payload.details.error.code, 'export_target_unwritable');
      assert.equal(payload.details.error.phase, 'validate');
      assert.doesNotMatch(payload.details.error.message, /[\u0000-\u001f\u007f-\u009f]/, name);
      assert.equal('exported' in payload.details, false);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), listing);
    assert.equal(fs.readFileSync(file('exists.json'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(file('readonly.json'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
  });

  test('--export without a value is an argument error', async () => {
    const id = await makeJob('task');
    const r = await go([id, '--export']);
    assert.equal(r.code, 1);
    assert.equal(r.err, 'antigravity:result — missing value for --export\n');
  });

  test('a job that is not finished is refused as result refuses it, and nothing is written', async () => {
    const id = await makeJob('task', { status: 'running' });
    const r = await go([id, '--export', 'job.json']);
    assert.equal(r.code, 1);
    assert.match(r.err, /is still running/);
    assert.equal(fs.existsSync(file('job.json')), false);
  });

  test('a refusal comes before the usage trailer and before any output', async () => {
    const id = await makeJob('task');
    fs.writeFileSync(file('exists.json'), 'original');
    const r = await go([id, '--export', 'exists.json']);
    assert.doesNotMatch(r.err, /usage: total=/);
  });

  test('an unknown job is refused and nothing is written', async () => {
    const r = await go(['ffffffffffff', '--export', 'job.json']);
    assert.equal(r.code, 1);
    assert.equal(fs.existsSync(file('job.json')), false);
  });
});

// Oracle: package J, a stored answer must arrive whole through a CLI pipe.
test('result --json sends a 512 KiB stored answer through a pipe without cutting it', async () => {
  const answer = 'z'.repeat(512 * 1024);
  const id = await makeJob('task', { rawOutput: answer });
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL('../bin/antigravity.mjs', import.meta.url)), 'result', id, '--json'],
    { cwd: dir, env: { ...process.env, AGY_BIN: path.join(dir, 'missing-agy') }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).answer, answer + '\n');
});
