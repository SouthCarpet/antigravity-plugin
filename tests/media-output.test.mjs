/**
 * `media --output <path>` and the `media --transcript --timestamps`
 * command cases (3.2.0).
 *
 * agy is mocked in process (the pattern of tests/media-command.test.mjs);
 * yt-dlp is the process-level fixture of tests/helpers/fake-yt-dlp.mjs.
 *
 *   node --test --experimental-test-module-mocks tests/media-output.test.mjs
 */
import { test, mock, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStdio } from './helpers/capture-stdio.mjs';
import { writeFixtureYtDlp } from './helpers/fake-yt-dlp.mjs';
import { resolveJobsDir, readJobFile } from '../scripts/lib/state.mjs';
import { OAUTH_URL_MARKER } from '../scripts/lib/safe-reason.mjs';

const agy = { calls: [], next: null, hook: null };
const completed = (stdout, extra = {}) => ({
  status: 'completed', exitCode: 0, stdout, stderr: '', usage: null, durationSeconds: 1, ...extra,
});
mock.module('../scripts/lib/agent-runtime.mjs', {
  namedExports: {
    runAgyPrint: async (opts) => {
      agy.calls.push(opts);
      agy.hook?.(opts);
      return { ...agy.next };
    },
    resolveAgyBin: () => 'agy',
    probeAgyModels: async () => ({ ok: false, reason: 'not scripted' }),
    probeAgy: async () => ({ ok: true, version: 'test' }),
    DEFAULT_AGY_BIN: 'agy',
  },
});
const { run } = await import('../scripts/commands/media.mjs');

const URL = 'https://youtu.be/jNQXAC9IVRw';
const ANSWER = '## Transcription\npineapple\n## Answer\nAudio.';
let toolsDir;
let dir;
let wav;
const saved = { path: process.env.PATH, data: process.env.CLAUDE_PLUGIN_DATA };

before(() => {
  toolsDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'media-output-tools-')));
  writeFixtureYtDlp(toolsDir);
});
beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'media-output-')));
  process.env.CLAUDE_PLUGIN_DATA = path.join(dir, 'data');
  process.env.PATH = toolsDir + path.delimiter + saved.path;
  fs.rmSync(path.join(toolsDir, 'argv.txt'), { force: true });
  wav = path.join(dir, 'speech.wav');
  fs.writeFileSync(wav, 'audio');
  agy.calls = [];
  agy.hook = null;
  agy.next = completed(ANSWER);
});
afterEach(() => {
  process.env.PATH = saved.path;
  if (saved.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = saved.data;
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

function jobFiles() {
  const jobs = resolveJobsDir(dir);
  return fs.existsSync(jobs) ? fs.readdirSync(jobs).filter((name) => name.endsWith('.json')) : [];
}

const file = (name) => path.join(dir, name);
const bytesOf = (name) => fs.readFileSync(file(name));

// Oracle: the file is the stdout answer text plus one final newline.
describe('what is written', () => {
  test('a local run saves the answer text exactly as stdout prints it, plus one newline, and prints Saved last', async () => {
    const r = await go([wav, '--output', 'out.txt']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(bytesOf('out.txt'), Buffer.from(`${ANSWER}\n`, 'utf8'));
    assert.equal(r.out, `${ANSWER}\nSaved: ${file('out.txt')}\n`);
  });

  test('an answer that already ends with a newline is saved without a second one', async () => {
    agy.next = completed(`${ANSWER}\n`);
    const r = await go([wav, '--output', 'out.md']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(bytesOf('out.md'), Buffer.from(`${ANSWER}\n`, 'utf8'));
    assert.equal(r.out, `${ANSWER}\nSaved: ${file('out.md')}\n`);
  });

  test('the file is UTF-8 with no byte order mark and the extension converts nothing', async () => {
    agy.next = completed('zlučka ✓');
    await go([wav, '--output', 'out.html']);
    assert.deepEqual([...bytesOf('out.html')], [...Buffer.from('zlučka ✓\n', 'utf8')]);
  });

  test('--json adds details.output with the path and the byte count and changes nothing else', async () => {
    const plain = JSON.parse((await go([wav, '--json'])).out);
    const withFlag = JSON.parse((await go([wav, '--json', '--output', 'out.txt'])).out);
    assert.deepEqual(withFlag.details.output, { path: file('out.txt'), bytes: bytesOf('out.txt').length });
    assert.equal(withFlag.details.output.bytes, Buffer.byteLength(`${ANSWER}\n`));
    const { output: saved, ...rest } = withFlag.details;
    assert.equal(saved.path, file('out.txt'));
    assert.deepEqual(Object.keys(rest), Object.keys(plain.details));
    assert.equal(withFlag.answer, plain.answer);
    assert.equal(withFlag.status, plain.status);
  });

  // Oracle: key list printed by the base commit 966559d for the same run.
  test('without the flag, text output and the details keys are the base output', async () => {
    const text = await go([wav]);
    assert.equal(text.out, ANSWER);
    const json = JSON.parse((await go([wav, '--json'])).out);
    assert.deepEqual(Object.keys(json.details), [
      'source', 'mode', 'quality', 'mediaPath', 'mimeType', 'bytes', 'videoId', 'ytDlpVersion', 'usage', 'durationSeconds',
    ]);
    assert.equal('output' in json.details, false);
    assert.equal('timestamped' in json.details, false);
    assert.equal(fs.readdirSync(dir).includes('out.txt'), false);
  });

  test('a YouTube transcript-only run saves the transcript', async () => {
    const r = await go([URL, '--transcript', '--output', 'transcript.txt']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(bytesOf('transcript.txt'), Buffer.from('pineapple\n'));
    assert.equal(r.out, `pineapple\nSaved: ${file('transcript.txt')}\n`);
    assert.equal(agy.calls.length, 0);
  });

  test('a transcript-only run with --timestamps saves the timestamped lines, and details.timestamped is true', async () => {
    const r = await go([URL, '--transcript', '--timestamps', '--output', 'transcript.txt', '--json']);
    assert.equal(r.code, 0, r.err);
    const payload = JSON.parse(r.out);
    assert.equal(payload.answer, '[00:00:00] pineapple');
    assert.equal(payload.details.timestamped, true);
    assert.deepEqual(bytesOf('transcript.txt'), Buffer.from('[00:00:00] pineapple\n'));
  });

  test('--timestamps alone changes only the transcript text and adds only details.timestamped', async () => {
    const plain = JSON.parse((await go([URL, '--transcript', '--json'])).out);
    const stamped = JSON.parse((await go([URL, '--transcript', '--timestamps', '--json'])).out);
    assert.equal(plain.answer, 'pineapple');
    assert.equal('timestamped' in plain.details, false);
    const { timestamped, ...rest } = stamped.details;
    assert.equal(timestamped, true);
    assert.deepEqual(Object.keys(rest), Object.keys(plain.details));
    assert.equal(stamped.answer, '[00:00:00] pineapple');
  });

  test('a transcript run with a prompt gives the model the timestamped transcript and saves the model answer', async () => {
    const r = await go([URL, '--transcript', '--timestamps', '--prompt', 'Summarize.', '--output', 'summary.md']);
    assert.equal(r.code, 0, r.err);
    assert.match(agy.calls.at(-1).prompt, /\[00:00:00\] pineapple/);
    assert.deepEqual(bytesOf('summary.md'), Buffer.from(`${ANSWER}\n`));
  });

  test('a YouTube video run saves the model answer', async () => {
    const r = await go([URL, '--output', 'video.txt']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(bytesOf('video.txt'), Buffer.from(`${ANSWER}\n`));
  });

  test('the expectations block, the Kept line and the usage trailer are not in the file; Saved is the last line', async () => {
    agy.next = completed(ANSWER, { usage: { total_tokens: 10, input_tokens: 7, output_tokens: 3 } });
    const r = await go([URL, '--expect', 'pineapple', '--keep', '--output', 'video.txt']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(bytesOf('video.txt'), Buffer.from(`${ANSWER}\n`));
    assert.match(r.out, /\nExpectations: all_found\n\nKept: [^\n]+\nSaved: [^\n]+\n$/);
    assert.ok(r.out.endsWith(`\nSaved: ${file('video.txt')}\n`));
    assert.match(r.err, /usage: total=10 in=7 out=3/);
    const content = bytesOf('video.txt').toString('utf8');
    assert.doesNotMatch(content, /Expectations|Kept:|usage:|Saved:/);
  });

  test('an OAuth URL in the answer is redacted in the file as it is on stdout', async () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=attacker&redirect_uri=https%3A%2F%2Fevil.test';
    agy.next = completed(`Sign in at ${url} now`);
    const r = await go([wav, '--output', 'out.txt']);
    assert.equal(r.code, 0, r.err);
    const content = bytesOf('out.txt').toString('utf8');
    assert.equal(content, `Sign in at ${OAUTH_URL_MARKER} now\n`);
    assert.doesNotMatch(content, /accounts\.google\.com\/o\/oauth2/);
    assert.ok(r.out.startsWith(`Sign in at ${OAUTH_URL_MARKER} now`));
  });

  test('--cwd decides where a relative path goes', async () => {
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    const r = await go([wav, '--output', 'rel.txt', '--cwd', sub], { cwd: undefined });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(path.join(sub, 'rel.txt')), true);
    assert.equal(fs.existsSync(file('rel.txt')), false);
  });
});

// Oracle: never overwrites, checked early: refusal before any spawn, record or write.
describe('target refusals', () => {
  function makeTargets() {
    const targets = {};
    fs.writeFileSync(file('exists.txt'), 'original');
    targets.file = ['exists.txt', /^Output target already exists as a file: /];
    fs.mkdirSync(file('folder'));
    targets.directory = ['folder', /^Output target already exists as a directory: /];
    fs.writeFileSync(file('readonly.txt'), 'original');
    fs.chmodSync(file('readonly.txt'), 0o444);
    targets.readOnly = ['readonly.txt', /^Output target already exists as a file: /];
    targets.missingParent = [path.join('missing', 'out.txt'), /^Output target directory does not exist: /];
    targets.empty = ['', /^Output path is empty\./];
    targets.control = ['bad\u001bname.txt', /^Output path holds a control character \(shown escaped\): bad\\u001bname\.txt$/];
    fs.mkdirSync(file('real-dir'));
    try {
      fs.symlinkSync(file('real-dir'), file('link'), 'junction');
      targets.link = ['link', /^Output target already exists as a link: /];
    } catch { /* links are not available here */ }
    return targets;
  }

  for (const input of ['local', 'youtube']) {
    test(`every refused target (${input}) gives invalid_input, no agy, no yt-dlp, no job record and no change`, async () => {
      const targets = makeTargets();
      // An absent yt-dlp would answer yt_dlp_missing: seeing the target code proves the target is checked first.
      if (input === 'youtube') process.env.PATH = '';
      const source = input === 'local' ? wav : URL;
      const listing = fs.readdirSync(dir).sort();
      for (const [name, [value, message]] of Object.entries(targets)) {
        for (const json of [false, true]) {
          const r = await go([source, '--output', value, ...(json ? ['--json'] : [])]);
          assert.equal(r.code, 1, `${name}: ${r.err}`);
          const line = r.err.split('\n').find((candidate) => candidate.startsWith('antigravity:media: '));
          assert.match(line.slice('antigravity:media: '.length), message, name);
          assert.doesNotMatch(r.err, /[\u0000-\u0008\u000b-\u001f\u007f]/, `${name}: raw control character in stderr`);
          if (json) {
            const payload = JSON.parse(r.out);
            assert.equal(payload.status, 'invalid_input');
            assert.equal(payload.jobId, null);
            assert.equal(payload.details.error.code, 'output_target_unwritable');
            assert.doesNotMatch(payload.details.error.message, /[\u0000-\u001f\u007f-\u009f]/, `${name}: raw control character in the message`);
          } else {
            assert.equal(r.out, '');
          }
        }
      }
      assert.equal(agy.calls.length, 0);
      assert.deepEqual(jobFiles(), []);
      assert.deepEqual(fs.readdirSync(dir).sort(), listing);
      assert.equal(fs.readFileSync(file('exists.txt'), 'utf8'), 'original');
      assert.equal(fs.readFileSync(file('readonly.txt'), 'utf8'), 'original');
      assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
    });
  }

  test('a refused target costs no download: the downloader is never started', async () => {
    fs.writeFileSync(file('exists.txt'), 'original');
    const r = await go([URL, '--transcript', '--output', 'exists.txt']);
    assert.equal(r.code, 1);
    assert.equal(fs.existsSync(path.join(toolsDir, 'argv.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'state', 'media')), false);
  });

  test('--output without a value is an argument error', async () => {
    const r = await go([wav, '--output']);
    assert.equal(r.code, 1);
    assert.match(r.err, /missing value for --output/);
    assert.equal(agy.calls.length, 0);
  });
});

// Oracle: "Nothing is written unless the run completes" and "Late failure".
describe('runs that do not complete, and a target that appears during the run', () => {
  for (const [status, exitCode] of [['failed', 1], ['cancelled', 2], ['timeout', 1]]) {
    test(`a ${status} run leaves no file`, async () => {
      agy.next = { status, exitCode: 1, stdout: 'partial answer', stderr: 'boom', usage: null };
      const r = await go([wav, '--output', 'out.txt']);
      assert.equal(r.code, exitCode, r.err);
      assert.equal(fs.existsSync(file('out.txt')), false);
      assert.doesNotMatch(r.out, /Saved:/);
    });
  }

  test('a target that appears during the run gives exit 1, the unchanged stdout and a completed job', async () => {
    const plain = await go([wav]);
    agy.hook = () => fs.writeFileSync(file('late.txt'), 'someone else');
    const r = await go([wav, '--output', 'late.txt']);
    assert.equal(r.code, 1);
    assert.equal(r.out, plain.out);
    assert.equal(fs.readFileSync(file('late.txt'), 'utf8'), 'someone else');
    assert.ok(
      r.err.includes(`antigravity:media: output not saved (output_target_unwritable): Output target already exists: ${file('late.txt')}. The plugin never overwrites.\n`),
      r.err,
    );
    const jobs = jobFiles().map((name) => JSON.parse(fs.readFileSync(path.join(resolveJobsDir(dir), name), 'utf8')));
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((job) => job.status), ['completed', 'completed']);
  });

  test('the same late failure in --json mode keeps the envelope without details.output', async () => {
    agy.hook = () => fs.writeFileSync(file('late.txt'), 'someone else');
    const r = await go([wav, '--output', 'late.txt', '--json']);
    assert.equal(r.code, 1);
    const payload = JSON.parse(r.out);
    assert.equal(payload.status, 'completed');
    assert.equal('output' in payload.details, false);
    assert.equal(readJobFile(dir, payload.jobId).status, 'completed');
    assert.match(r.err, /output not saved \(output_target_unwritable\)/);
  });
});
