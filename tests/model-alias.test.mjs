/** Oracles: package A brief and plan 153 A1/A2/A3, including the captured agy 1.5.3 table. */
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
for (const text of ['', 'id name', 'id\tname\textra', 'id\t', '\u0000\tname', 'Please sign in']) {
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
    assert.equal((await resolveRequestModel(base)).model, 'old-exact-id');
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
    { cwd, env, encoding: 'utf8', timeout: 30000 });
}
function argvOf(stderr) {
  return stderr.split(/\r?\n/).map((line) => line.replace(/^\uFEFF/, ''))
    .filter((line) => line.startsWith('arg=')).map((line) => line.slice(4));
}
it('all five verbs resolve the captured alias through the real CLI and store separate provenance (A1)', () => {
  const fake = writeFakeAgy(root, 'run', { modelsText: table, versionOk: true, echoArgsStderr: true,
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"ok","model":"reported"}}\n' });
  const work = path.join(root, 'cli'); fs.mkdirSync(work);
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
    const conflict = cli([...args, '--model', 'exact', '--model-alias', 'flash'], env, work);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /cannot combine/);
  }
  const exact = cli(['rescue', 'ok', '--model', 'unlisted', '--json'], env, work);
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
      request: { model: 'exact-old-model' } });
    await patchJob(work, job.id, { result: { agyConversationId: 'native-id' } });
    for (const conversationId of [undefined, 'caller-id', 'native-id']) {
      const resumed = await resolveRequestModel({ workspaceRoot: work, kind, env,
        mode: conversationId ? 'conversation' : 'continue', conversationId, probe: neverProbe });
      assert.deepEqual(resumed, { ok: true, model: 'exact-old-model',
        request: { resolvedModel: 'exact-old-model', replayedFromJobId: job.id } });
    }
  });
}
