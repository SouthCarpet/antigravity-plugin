/** Package D contract oracles: controller rulings 1 to 4. */
import { it, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync as realSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { portableTmpRoot, removeTestDir } from './helpers/tmp.mjs';

const root = fs.mkdtempSync(path.join(portableTmpRoot(), 'receipt-contract-'));
after(() => removeTestDir(root));
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url),'utf8')).version;
const calls = [];
let probe = { status: 0, stdout: '--model --print', stderr: '' };
let missing = false;
mock.module('../scripts/lib/process-adapter.mjs', { namedExports: {
  spawn(bin, argv) {
    calls.push(argv);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    process.nextTick(() => {
      if (missing) { child.emit('error', Object.assign(new Error('missing'), {code:'ENOENT'})); return; }
      child.stdout.end(argv[0] === '--version' ? '1.5.1' : '--model --print');
      child.emit('close', 0);
    });
    return child;
  },
  spawnSync(bin, argv, options) {
    // Only the help probe is faked. Other tools (git, the start-time query)
    // reach spawnSync through the same adapter and run for real.
    if (!(argv?.length === 1 && argv[0] === '--help')) return realSpawnSync(bin, argv, options);
    calls.push(argv);
    assert.equal(options.timeout, 1000, 'ruling 4 bounds the probe');
    assert.equal(options.killSignal, 'SIGKILL');
    return probe;
  },
}});
mock.module('../scripts/lib/media.mjs', {namedExports:{mediaDoctor:()=>({ytDlp:{path:'PRIVATE-PATH',version:null},ffmpeg:{path:'HOST-MARKER'},sizeCapBytes:100000000})}});
const { run } = await import('../scripts/commands/doctor.mjs');
const { createTrackedJob } = await import('../scripts/lib/job-helpers.mjs');
const { readJobFile } = await import('../scripts/lib/state.mjs');
const expectedFlags = {
  '--add-dir':'not_listed', '--model':'listed', '--effort':'not_listed',
  '--mode':'listed', '--continue':'not_listed', '--conversation':'not_listed',
  '--print-timeout':'not_listed', '--disable-slash-commands':'not_listed',
  '--input-format':'not_listed', '--output-format':'not_listed', '--print':'listed', '--json-schema':'not_listed',
};
async function capture(args) {
  const privateEnv = { USERNAME:process.env.USERNAME, COMPUTERNAME:process.env.COMPUTERNAME };
  process.env.USERNAME='RECEIPT-PRIVATE-USER'; process.env.COMPUTERNAME='RECEIPT-PRIVATE-HOST';
  let text = ''; const saved = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => { if (typeof chunk !== 'string') return saved.call(process.stdout, chunk, ...rest); text += chunk; return true; };
  try { return { code: await run(args, {cwd:root}), get text() { return text; } }; }
  finally { process.stdout.write = saved; for (const [key,value] of Object.entries(privateEnv)) { if (value === undefined) delete process.env[key]; else process.env[key]=value; } }
}
it('receipt has the closed redacted key set and no added agy spawn (rulings 1 and 2)', async () => {
  calls.length = 0;
  const plain = await capture(['--json']);
  assert.deepEqual(calls, [['--version'], ['--help']]);
  calls.length = 0;
  const receipt = await capture(['--receipt','--json']);
  assert.deepEqual(calls, [['--version'], ['--help']]);
  const payload = JSON.parse(receipt.text);
  const expected = { pluginVersion:packageVersion, agyVersion:'1.5.1', classification:'verified', listedFlags:expectedFlags, modelFamilies:'unknown' };
  assert.deepEqual(payload.details.receipt, expected);
  delete payload.details.receipt;
  assert.deepEqual(payload, JSON.parse(plain.text));
  assert.equal(receipt.code, plain.code);
  const text = await capture(['--receipt']);
  assert.deepEqual(JSON.parse(text.text), expected);
  assert.ok(!text.text.includes(root));
  assert.ok(!text.text.includes('PRIVATE-PATH'));
  assert.ok(!text.text.includes('HOST-MARKER'));
  assert.ok(!text.text.includes('RECEIPT-PRIVATE-USER'));
  assert.ok(!text.text.includes('RECEIPT-PRIVATE-HOST'));
});
it('absent agy gives null version, missing classification and all flags not listed (ruling 2)', async () => {
  missing = true;
  try {
    const output = await capture(['--receipt','--json']);
    const receipt = JSON.parse(output.text).details.receipt;
    assert.equal(output.code,1);
    assert.deepEqual(receipt, {pluginVersion:packageVersion,agyVersion:null,classification:'missing',listedFlags:{...expectedFlags,'--model':'not_listed','--mode':'not_listed','--print':'not_listed'},modelFamilies:'unknown'});
  } finally { missing = false; }
});
it('every job gets exactly one bounded help probe and the shared flag states (rulings 3 and 4)', async () => {
  calls.length=0;
  const job = await createTrackedJob({workspaceRoot:root,kind:'task',agyVersion:'1.5.1'});
  assert.deepEqual(calls,[['--help']]);
  assert.deepEqual(readJobFile(root,job.id).provenance.listedFlags,expectedFlags);
});
for (const [name,result] of [
  ['failed',{error:new Error('spawn failed')}],
  ['nonzero',{status:1,stdout:'--model'}],
  ['empty',{status:0,stdout:'',stderr:''}],
  ['timeout',{status:null,error:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})}],
]) {
  it(`${name} help stores null and still creates a queued job (ruling 4)`, async () => {
    probe=result;
    const job = await createTrackedJob({workspaceRoot:root,kind:'task',agyVersion:'1.5.1'});
    assert.equal(job.status,'queued');
    assert.equal(readJobFile(root,job.id).provenance.listedFlags,null);
  });
}
// Oracles: controller ruling 4, all preview verbs and resumed creation.
for (const kind of ['task','rescue','vision','media','review']) {
  it(`${kind} preview spawns no help probe (ruling 4)`, async () => {
    const { buildRunPreview } = await import('../scripts/lib/job-helpers.mjs');
    calls.length=0;
    buildRunPreview({kind,prompt:'preview',options:{}});
    assert.deepEqual(calls,[]);
  });
}
it('resumed creation captures a new listing once (ruling 4)', async () => {
  probe={status:0,stdout:'--model --print',stderr:''}; calls.length=0;
  const job=await createTrackedJob({workspaceRoot:root,kind:'task',agyVersion:'1.5.1',request:{mode:'conversation',replayedFromJobId:'old-job'}});
  assert.deepEqual(job.provenance.listedFlags,expectedFlags);
  assert.deepEqual(calls,[['--help']]);
});
