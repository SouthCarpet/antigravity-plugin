/** Oracles: package A brief and plan 153 A1/A2/A3, including the captured agy 1.5.3 table. */
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseModelsListing, selectAliasModel, compareModelVersions } from '../scripts/lib/model-alias.mjs';
import { probeAgyModels } from '../scripts/lib/agent-runtime.mjs';
import { resolveRequestModel, createTrackedJob, patchJob, finishForeground } from '../scripts/lib/job-helpers.mjs';
import { checkDefaultModel } from '../scripts/commands/setup.mjs';
import { writeFakeAgy } from './helpers/fake-agy.mjs';

const table = fs.readFileSync(new URL('./fixtures/models-agy-1.5.3.txt', import.meta.url), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-alias-'));
const oldData = process.env.CLAUDE_PLUGIN_DATA;
process.env.CLAUDE_PLUGIN_DATA = path.join(root, 'data');
after(() => {
  if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = oldData;
  fs.rmSync(root, { recursive: true, force: true });
});
const rows = parseModelsListing(table).rows;
const select = (alias, effort, input = rows) => selectAliasModel(input, alias, effort);
const neverProbe = () => { throw new Error('listing must not run'); };

it('captured table and reversed CRLF rows select medium for all six literal families; pro is absent', () => {
  for (const input of [rows, parseModelsListing(table.trim().split(/\r?\n/).reverse().join('\r\n')).rows]) {
    for (const [alias, model] of Object.entries({ flash: 'gemini-3.8-flash-medium',
      argon: 'gemini-4-argon-medium', sonnet: 'claude-sonnet-5-5-medium',
      opus: 'claude-opus-5-5-medium', 'gpt-oss': 'gpt-oss-120b-medium' })) {
      assert.deepEqual(select(alias, undefined, input), { ok: true, model });
    }
    assert.match(select('pro', undefined, input).reason, /family absent \(pro\)/);
  }
});
for (const text of ['', 'id name', 'id\tname\textra', 'id\t', '\u0000\tname', 'Please sign in', '--flash-medium\tBad']) {
  it(`parser refuses malformed or empty input ${JSON.stringify(text)} as a whole (A1)`, () => {
    assert.equal(parseModelsListing(text).ok, false);
  });
}
it('duplicate ids keep the first name and do not change the selection (A1)', () => {
  const parsed = parseModelsListing('flash-4-medium\tFirst\nflash-4-medium\tSecond');
  assert.deepEqual(parsed.rows, [{ id: 'flash-4-medium', name: 'First' }]);
});
it('numeric family versions win before effort selection, independent of order (OPEN-1)', () => {
  assert.ok(compareModelVersions('gemini-3.10-flash-high', 'gemini-3.9-flash-high') > 0);
  assert.ok(compareModelVersions('claude-sonnet-5-10', 'claude-sonnet-5-9') > 0);
  const versions = parseModelsListing('flash-3.9-high\tOld\nflash-3.10-medium\tNew').rows;
  assert.equal(select('flash', undefined, versions).model, 'flash-3.10-medium');
  assert.match(select('flash', 'high', versions).reason, /effort mismatch/);
  assert.equal(select('flash', 'high').model, 'gemini-3.8-flash-high');
  assert.equal(select('flash', 'agy-default').model, 'gemini-3.8-flash-medium');
  assert.equal(select('flash', undefined, [{ id: 'flash-4', name: 'Only' }]).model, 'flash-4');
});
it('unknown aliases and synthetic multiple families refuse instead of guessing (A1)', () => {
  assert.match(select('unknown').reason, /unknown model alias/);
  assert.equal(select('bad\nalias').reason.includes('\n'), false);
  assert.match(selectAliasModel(rows, 'mixed', undefined, { mixed: ['flash', 'argon'] }).reason,
    /multiple families/);
});
it('exact id bypasses even a failing listing, while conflicting flags refuse (A1)', async () => {
  assert.deepEqual(await resolveRequestModel({ modelOption: 'unlisted-new-id', probe: neverProbe }),
    { ok: true, model: 'unlisted-new-id', request: {} });
  assert.equal((await resolveRequestModel({ modelOption: 'id', aliasOption: 'flash', probe: neverProbe })).ok, false);
});
for (const [name, opts] of Object.entries({ missing: null, exit: { exitCode: 3 },
  timeout: { delayMs: 1000 }, auth: { stderr: 'Authentication required' }, empty: {},
  malformed: { stdout: 'Please sign in' } })) {
  it(`listing ${name} gives the shared refusal and setup unknown, never absent (A1/A2)`, async () => {
    const bin = opts === null ? path.join(root, 'missing') : writeFakeAgy(root, `probe-${name}`, opts);
    const probe = () => probeAgyModels({ bin, timeoutMs: name === 'timeout' ? 100 : 5000 });
    const result = await resolveRequestModel({ aliasOption: 'flash', probe });
    assert.equal(result.ok, false);
    assert.match(result.reason, /listing unavailable.*run setup or pass --model <id>/);
    assert.equal(await checkDefaultModel({ probe }), 'unknown');
  });
}
it('setup distinguishes a valid present table from a valid absent table (A2)', async () => {
  assert.equal(await checkDefaultModel({ probe: async () => ({ ok: true, text: table }) }), 'present');
  assert.equal(await checkDefaultModel({ probe: async () => ({ ok: true, text: 'flash-9-medium\tNew' }) }),
    'absent');
});
it('resume replays ids, keeps old/external jobs unlocked, and permits overrides (F4)',
  async () => {
    const work = path.join(root, 'resume'); fs.mkdirSync(work);
    const env = { ANTIGRAVITY_PLUGIN_SESSION_ID: 'alias-session' };
    const base = { workspaceRoot: work, kind: 'task', mode: 'continue', env, probe: neverProbe };
    assert.equal((await resolveRequestModel(base)).model, undefined);
    const legacy = await createTrackedJob({ workspaceRoot: work, kind: 'task', env });
    assert.deepEqual(await resolveRequestModel(base), { ok: true, model: undefined, request: {} });
    await patchJob(work, legacy.id, { provenance: { model: 'old-exact-id' } });
    assert.equal((await resolveRequestModel(base)).model, undefined);
    for (const resolvedModel of [null, '', 42]) {
      await patchJob(work, legacy.id, { provenance: { model: 'old-exact-id', resolvedModel } });
      assert.deepEqual(await resolveRequestModel(base), { ok: true, model: undefined, request: {} });
    }
    await patchJob(work, legacy.id, { provenance: { model: 'old-exact-id', resolvedModel: 'flash-4-high' },
      result: { agyConversationId: 'native-conversation' } });
    const replay = await resolveRequestModel({ ...base, mode: 'conversation', conversationId: 'native-conversation' });
    assert.deepEqual(replay.request, { resolvedModel: 'flash-4-high', replayedFromJobId: legacy.id });
    assert.equal((await resolveRequestModel({ ...base, conversationId: 'external' })).model, undefined);
    assert.equal((await resolveRequestModel({ ...base, env: { ANTIGRAVITY_PLUGIN_SESSION_ID: 'other' } })).model,
      undefined);
    assert.equal((await resolveRequestModel({ ...base, modelOption: 'override' })).model, 'override');
    const alias = await resolveRequestModel({ ...base, aliasOption: 'argon',
      probe: async () => ({ ok: true, text: table }) });
    assert.deepEqual(alias.request, { requestedAlias: 'argon', resolvedModel: 'gemini-4-argon-medium' });
  });

function captureFinish(kind, provenance, reportedModel, status = 'completed') {
  let out = '', err = '';
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = (s) => { out += s; return true; };
  process.stderr.write = (s) => { err += s; return true; };
  try {
    const code = finishForeground(kind, { id: 'test', provenance },
      { status, stdout: 'ok', stderr: '', reportedModel, exitCode: status === 'completed' ? 0 : 1 }, { json: true });
    return { code, err, details: JSON.parse(out).details };
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}
for (const kind of ['task', 'rescue', 'review', 'vision', 'media']) {
  it(`${kind} reports normalized model mismatch without changing exit codes; absent model is silent (A3)`, () => {
    for (const status of ['completed', 'failed']) {
      const mismatch = captureFinish(kind, { model: 'requested' }, 'different', status);
      assert.equal(mismatch.code, status === 'completed' ? 0 : 1);
      assert.equal(mismatch.details.modelMismatch, true);
      assert.match(mismatch.err, /warning: agy reported model "different", requested "requested"/);
    }
    assert.equal(captureFinish(kind, { model: ' Requested ' }, 'REQUESTED').details.modelMismatch, false);
    const absent = captureFinish(kind, { model: 'requested' }, null);
    assert.equal('modelMismatch' in absent.details, false);
    assert.doesNotMatch(absent.err, /reported model/);
  });
}

const bin = fileURLToPath(new URL('../bin/antigravity.mjs', import.meta.url));
function cli(args, env, cwd) {
  return spawnSync(process.execPath, [bin, ...args],
    { cwd, env, encoding: 'utf8', timeout: 90000 });
}
function canonicalArgv(argv) {
  return argv.map((arg, index) => argv[index - 1] === '--add-dir' ? fs.realpathSync.native(arg) : arg);
}
function argvOf(stderr) {
  return stderr.split(/\r?\n/).map((line) => line.replace(/^\uFEFF/, ''))
    .filter((line) => line.startsWith('arg=')).map((line) => line.slice(4));
}
it('all five verbs resolve the captured alias through the real CLI and store separate provenance (A1)', () => {
  const fake = writeFakeAgy(root, 'run', { modelsText: table, versionOk: true, echoArgsStderr: true,
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok","model":"reported"}}\n' });
  const physical = path.join(root, 'cli-physical'); fs.mkdirSync(physical);
  const work = path.join(root, 'cli'); fs.symlinkSync(physical, work, process.platform === 'win32' ? 'junction' : 'dir');
  spawnSync('git', ['init', '-q', work]);
  spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com',
    'commit', '--allow-empty', '-qm', 'Baseline'], { cwd: work });
  fs.writeFileSync(path.join(work, 'file.txt'), 'untracked change');
  fs.writeFileSync(path.join(work, 'image.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(work, 'sound.wav'), 'RIFFtest');
  const env = { ...process.env, AGY_BIN: fake, CLAUDE_PLUGIN_DATA: path.join(root, 'cli-data') };
  const cases = [ ['task', 'ok', '--foreground'], ['rescue', 'ok'], ['review'],
    ['vision', path.join(work, 'image.png')], ['media', path.join(work, 'sound.wav')] ];
  for (const args of cases) {
    const res = cli([...args, '--model-alias', 'flash', '--json'], env, work);
    assert.equal(res.status, 0, `${args[0]}: ${res.stderr} ${res.stdout}`);
    const result = JSON.parse(res.stdout);
    assert.deepEqual(result.details.modelAlias, { requestedAlias: 'flash',
      resolvedModel: 'gemini-3.8-flash-medium', listingSource: 'agy models' });
    const stored = JSON.parse(cli(['result', result.jobId, '--json'], env, work).stdout);
    assert.equal(stored.details.provenance.requestedAlias, 'flash');
    assert.equal(stored.details.provenance.resolvedModel, 'gemini-3.8-flash-medium');
    assert.equal(stored.details.result.reportedModel, 'reported');
    assert.deepEqual(canonicalArgv(argvOf(stored.details.result.stderr)), canonicalArgv([
      ...(args[0] === 'media' ? ['--add-dir', work] : []), '--model', 'gemini-3.8-flash-medium', '--print-timeout', '1860s', '--disable-slash-commands',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '']));
    const exactRun = cli([...args, '--model', 'unlisted', '--json'], env, work);
    assert.equal(exactRun.status, 0, exactRun.stderr);
    const exactRecord = JSON.parse(cli(['result', JSON.parse(exactRun.stdout).jobId, '--json'], env, work).stdout);
    assert.deepEqual(canonicalArgv(argvOf(exactRecord.details.result.stderr)), canonicalArgv([
      ...(args[0] === 'media' ? ['--add-dir', work] : []), '--model', 'unlisted', '--print-timeout', '1860s', '--disable-slash-commands',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '']));
    const conflict = cli([...args, '--model', 'exact', '--model-alias', 'flash'], env, work);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /cannot combine/);
  }
  const background = cli(['task', 'ok', '--wait', '--show-result', '--model-alias', 'flash', '--json'], env, work);
  assert.equal(background.status, 0, background.stderr);
  assert.equal(JSON.parse(background.stdout).details.modelAlias.resolvedModel, 'gemini-3.8-flash-medium');
  assert.match(background.stderr, /warning: agy reported model "reported", requested "gemini-3.8-flash-medium"/);
  const exact = cli(['rescue' , 'ok', '--model', 'unlisted', '--json'], env, work);
  assert.equal(exact.status, 0, exact.stderr);
  const exactJob = JSON.parse(exact.stdout);
  const exactStored = JSON.parse(cli(['result', exactJob.jobId, '--json'], env, work).stdout);
  assert.deepEqual(argvOf(exactStored.details.result.stderr), [
    '--model', 'unlisted', '--print-timeout', '1860s', '--disable-slash-commands',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '']);
});

// Oracle: A1 resume contract; task continuation and both rescue resume spellings share exact replay.
for (const kind of ['task', 'rescue']) {
  it(`${kind} resumes current-session ids and explicit caller/native ids without a listing (F4)`, async () => {
    const work = path.join(root, `resume-${kind}`); fs.mkdirSync(work);
    const env = { ANTIGRAVITY_PLUGIN_SESSION_ID: `resume-${kind}` };
    const job = await createTrackedJob({ workspaceRoot: work, kind, env, conversationId: 'caller-id',
      request: { model: 'exact-old-model', resolvedModel: 'exact-old-model' } });
    await patchJob(work, job.id, { result: { agyConversationId: 'native-id' } });
    for (const conversationId of [undefined, 'caller-id', 'native-id']) {
      const resumed = await resolveRequestModel({ workspaceRoot: work, kind, env,
        mode: conversationId ? 'conversation' : 'continue', conversationId, probe: neverProbe });
      assert.deepEqual(resumed, { ok: true, model: 'exact-old-model',
        request: { resolvedModel: 'exact-old-model', replayedFromJobId: job.id } });
    }
  });
}

// A print marker distinguishes listing probes from forbidden model calls.
function failureStub(name, marker) {
  const dir = path.join(root, `failure-${name}`); fs.mkdirSync(dir);
  if (process.platform === 'win32') {
    const source = path.join(dir, 'stub.cs');
    fs.writeFileSync(source, `using System; using System.IO; using System.Threading;
class Stub { static int Main(string[] args) {
 if (Array.IndexOf(args, "--print") >= 0) { File.WriteAllText(@"${marker}", "spawned"); return 0; }
 if (args[0] == "--version") { Console.WriteLine("1.5.3"); return 0; }
 switch ("${name}") {
 case "exit": return 3;
 case "timeout": Thread.Sleep(25000); break;
 case "auth": Console.Error.WriteLine("Authentication required"); break;
 case "malformed": Console.WriteLine("not a table"); break;
 case "large": Console.Write(new string('x', 65537)); break;
 } return 0;
} }`);
    const exe = path.join(dir, 'agy.exe');
    execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', `/out:${exe}`, source]);
    return exe;
  }
  const stub = path.join(dir, 'agy');
  fs.writeFileSync(stub, `#!/bin/sh
case " $* " in *" --print "*) touch '${marker}'; exit 0;; esac
[ "$1" = --version ] && { echo 1.5.3; exit 0; }
case '${name}' in
exit) exit 3;; timeout) sleep 25;; auth) echo 'Authentication required' >&2;;
malformed) echo 'not a table';; large) head -c 65537 /dev/zero | tr '\\0' x;; esac
`, { mode: 0o755 });
  return stub;
}
for (const name of ['missing', 'exit', 'timeout', 'auth', 'empty', 'malformed', 'large']) {
  it(`CLI listing ${name} refuses without spawning a model call`, () => {
    const marker = path.join(root, `print-${name}`);
    const fake = name === 'missing' ? path.join(root, 'not-installed') : failureStub(name, marker);
    const res = cli(['task', 'ok', '--foreground', '--model-alias', 'flash', '--json'],
      { ...process.env, AGY_BIN: fake, ANTIGRAVITY_NO_UPDATE_CHECK: '1' }, root);
    assert.equal(res.status, name === 'missing' ? 127 : 1, res.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.match(res.stderr, name === 'missing' ? /not found at AGY_BIN/ : /listing unavailable/);
  });
}
it('missing AGY_BIN has identical complete preflight output with alias, exact id, and flag text after --', () => {
  const missing = path.join(root, 'missing-preflight');
  const env = { ...process.env, AGY_BIN: missing };
  for (const args of [['--model', 'exact'], ['--model-alias', 'flash'], ['--', '--model-alias']]) {
    const res = cli(['task', '--foreground', ...args], env, root);
    assert.equal(res.status, 127);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, `antigravity-plugin: \`agy\` not found at AGY_BIN=${missing}.\n` +
      'Install Google Antigravity CLI from https://antigravity.google/download or unset AGY_BIN.\n');
  }
});

it('unset AGY_BIN uses the PATH binary and setup JSON keeps its sign-in URL on stderr', () => {
  const dir = path.join(root, 'path-bin'); fs.mkdirSync(dir);
  const fake = writeFakeAgy(dir, 'agy', { versionOk: true, modelsText: table,
    stdout: 'https://example.test/oauth\n' });
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH,
    ANTIGRAVITY_NO_UPDATE_CHECK: '1' };
  delete env.AGY_BIN;
  const res = cli(['setup', '--skip-vision', '--json'], env, root);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).details.defaultModelCheck, 'present');
  assert.match(res.stderr, /https:\/\/example.test\/oauth/);
  const explicit = cli(['setup', '--skip-vision', '--json'], { ...env, AGY_BIN: fake }, root);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).details.defaultModelCheck, 'present');
  assert.match(explicit.stderr, /https:\/\/example.test\/oauth/);
});
