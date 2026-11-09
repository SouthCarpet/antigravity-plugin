import { removeTestDir } from './helpers/tmp.mjs';
// Regressions for the worker and state-save guarantees in docs/COMPATIBILITY.md.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../scripts/lib/atomic-state.mjs';
import { recordProcessStartTime } from '../scripts/lib/process.mjs';
import { waitForJob, patchJob } from '../scripts/lib/job-helpers.mjs';
import { resolveJobFile, readJobFile } from '../scripts/lib/state.mjs';
const roots=[];
const savedData=process.env.CLAUDE_PLUGIN_DATA;
afterEach(()=>{if(savedData===undefined)delete process.env.CLAUDE_PLUGIN_DATA;else process.env.CLAUDE_PLUGIN_DATA=savedData;for(const p of roots.splice(0))removeTestDir(p);});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'antigravity-hardening-'));roots.push(root);process.env.CLAUDE_PLUGIN_DATA=root;return root;}
for(const code of ['EPERM','EACCES','EBUSY'])test(`atomic rename retries ${code} and publishes the full value`,()=>{
 const root=fixture();const target=path.join(root,'value.json');fs.writeFileSync(target,'{"old":true}');
 const rename=fs.renameSync;let calls=0;
 fs.renameSync=(...args)=>{calls++;if(calls===1)throw Object.assign(new Error(code),{code});return rename(...args);};
 try{writeJsonAtomic(target,{new:true});assert.deepEqual(JSON.parse(fs.readFileSync(target,'utf8')),{new:true});assert.equal(calls,2);}finally{fs.renameSync=rename;}
});
test('permanent busy rename leaves the old target and no temporary file',()=>{
 const root=fixture();const target=path.join(root,'value.json');fs.writeFileSync(target,'{"old":true}');
 const rename=fs.renameSync;let calls=0;const start=Date.now();
 fs.renameSync=()=>{calls++;throw Object.assign(new Error('busy'),{code:'EPERM'});};
 try{assert.throws(()=>writeJsonAtomic(target,{new:true}),/busy/);assert.ok(calls>1);assert.ok(Date.now()-start<2000);assert.equal(fs.readFileSync(target,'utf8'),'{"old":true}');assert.deepEqual(fs.readdirSync(root),['value.json']);}finally{fs.renameSync=rename;}
});
test('disk full is not retried',()=>{
 const root=fixture();const rename=fs.renameSync;let calls=0;
 fs.renameSync=()=>{calls++;throw Object.assign(new Error('full'),{code:'ENOSPC'});};
 try{assert.throws(()=>writeJsonAtomic(path.join(root,'value.json'),{}),/full/);assert.equal(calls,1);assert.deepEqual(fs.readdirSync(root),[]);}finally{fs.renameSync=rename;}
});
test('launch retries one failed start-time query',()=>{let calls=0;assert.equal(recordProcessStartTime(4242,()=>++calls===1?null:1000),'1970-01-01T00:00:01.000Z');assert.equal(calls,2);});
test('launch stops after two failed start-time queries',()=>{let calls=0;assert.equal(recordProcessStartTime(4242,()=>{calls++;return null;}),null);assert.equal(calls,2);});
for(const replacement of [{id:'abcdefabcdef',status:'completed',workerPid:4242,result:{stdout:'real answer'}},{id:'abcdefabcdef',status:'failed',workerPid:4242,errorMessage:'real error'},{id:'abcdefabcdef',status:'cancelled',workerPid:4242},{id:'abcdefabcdef',status:'running',workerPid:4343}])test(`vanish probe preserves the fresh ${replacement.status} record`,async()=>{
 const root=fixture();await patchJob(root,'abcdefabcdef',{status:'running',workerPid:4242});const file=resolveJobFile(root,'abcdefabcdef');const expected=JSON.stringify(replacement);let calls=0;
 const actual=await waitForJob(root,'abcdefabcdef',{isProcessAlive:()=>{if(++calls===1)fs.writeFileSync(file,expected);return false;},terminateTree:async()=>{assert.fail('must not signal');}});
 assert.deepEqual(actual,replacement);assert.equal(fs.readFileSync(file,'utf8'),expected);
});
test('patch read failure preserves all existing fields',async()=>{
 const root=fixture();await patchJob(root,'abcdefabcdef',{status:'running',request:{prompt:'keep'}});const file=resolveJobFile(root,'abcdefabcdef');const expected=fs.readFileSync(file,'utf8');const read=fs.readFileSync;
 fs.readFileSync=(p,...args)=>{if(p===file)throw Object.assign(new Error('busy read'),{code:'EACCES'});return read(p,...args);};
 try{await assert.rejects(patchJob(root,'abcdefabcdef',{phase:'running'}),/busy read/);}finally{fs.readFileSync=read;}
 assert.equal(fs.readFileSync(file,'utf8'),expected);assert.deepEqual(readJobFile(root,'abcdefabcdef').request,{prompt:'keep'});
});

test('concurrent readers always parse a complete atomic value', async () => {
 const { Worker } = await import('node:worker_threads');
 const { once } = await import('node:events');
 const root=fixture();const target=path.join(root,'value.json');writeJsonAtomic(target,{text:'old'});
 const reader=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');let count=0;function read(){try{const value=JSON.parse(fs.readFileSync(workerData,'utf8'));if(!['old','new'].includes(value.text))throw new Error('invalid value');count++;}catch(e){parentPort.postMessage({error:e.message});}} read();parentPort.postMessage('ready');const timer=setInterval(read,0);parentPort.on('message',()=>{clearInterval(timer);parentPort.postMessage({count});parentPort.close();});`,{eval:true,workerData:target});
 try {
  assert.deepEqual((await once(reader,'message'))[0],'ready');
  for(let n=0;n<100;n++)writeJsonAtomic(target,{text:'new'});
  const done=once(reader,'message');reader.postMessage('stop');const [result]=await done;assert.equal(result.error,undefined);assert.ok(result.count>0);
 } finally {await reader.terminate();}
});


test('failed PID publication cannot replace a worker terminal result', async () => {
 const {EventEmitter}=await import('node:events');const {startBackgroundJob}=await import('../scripts/lib/job-helpers.mjs');const root=fixture();let bytes;let file;
 const launched=await startBackgroundJob({workspaceRoot:root,kind:'task',prompt:'go',readStartTime:()=>1000,
  spawnWorker:()=>{const child=Object.assign(new EventEmitter(),{pid:4242,unref(){}});queueMicrotask(()=>child.emit('spawn'));return child;},
  terminateTree:async()=>({outcome:'not_found'}),
  persistWorkerPid:async(cwd,id)=>{await patchJob(cwd,id,{status:'completed',workerPid:4242,result:{stdout:'done'}});file=resolveJobFile(cwd,id);bytes=fs.readFileSync(file,'utf8');throw new Error('index unavailable');},
 });
 assert.equal(launched.job.status,'completed');assert.equal(fs.readFileSync(file,'utf8'),bytes);
});

async function heldFakeAgy(root, name) {
 const { writeFakeAgy } = await import('./helpers/fake-agy.mjs');
 const { spawn } = await import('node:child_process');
 const { once } = await import('node:events');
 const bin = writeFakeAgy(root, name, { readStdin: true });
 const child = spawn(bin, [], { stdio: ['pipe', 'ignore', 'ignore'] });
 child.stdin.on('error', () => {});
 await once(child, 'spawn');
 return { child, exited: once(child, 'exit') };
}

test('a retried launch identity lets cancel stop the fake agy', async () => {
 const { createTrackedJob } = await import('../scripts/lib/job-helpers.mjs');
 const { readProcessStartTime } = await import('../scripts/lib/process.mjs');
 const { run: cancel } = await import('../scripts/commands/cancel.mjs');
 const root = fixture();
 const { child, exited } = await heldFakeAgy(root, 'agy-retry');
 try {
  let queries = 0;
  const started = Date.now();
  const identity = recordProcessStartTime(child.pid, pid => ++queries === 1 ? null : readProcessStartTime(pid));
  assert.equal(queries, 2);
  assert.equal(typeof identity, 'string');
  assert.ok(Date.now() - started < 10000);
  const job = await createTrackedJob({ workspaceRoot: root, kind: 'task', title: 'retry identity' });
  await patchJob(root, job.id, { status: 'running', agyPid: child.pid, agyProcessStartedAt: identity });
  assert.equal(readJobFile(root, job.id).agyProcessStartedAt, identity);
  assert.equal(await cancel([job.id, '--json'], { cwd: root, outputCommandResult: () => {} }), 0);
  await exited;
  assert.equal(readJobFile(root, job.id).status, 'cancelled');
 } finally {
  child.stdin.end();
  await exited;
 }
});

test('two failed launch queries leave the fake agy alive and log that it was not signalled', async () => {
 const { createTrackedJob } = await import('../scripts/lib/job-helpers.mjs');
 const { resolveJobLogFile } = await import('../scripts/lib/state.mjs');
 const { run: cancel } = await import('../scripts/commands/cancel.mjs');
 const root = fixture();
 const { child, exited } = await heldFakeAgy(root, 'agy-no-identity');
 try {
  let queries = 0;
  let signals = 0;
  const identity = recordProcessStartTime(child.pid, () => { queries++; return null; });
  assert.equal(queries, 2);
  assert.equal(identity, null);
  const job = await createTrackedJob({ workspaceRoot: root, kind: 'task', title: 'missing identity' });
  await patchJob(root, job.id, { status: 'running', agyPid: child.pid, agyProcessStartedAt: identity });
  const code = await cancel([job.id, '--json'], { cwd: root, outputCommandResult: () => {},
   terminateProcessTree: async () => { signals++; return { outcome: 'killed' }; },
  });
  assert.equal(code, 1);
  assert.equal(signals, 0);
  assert.equal(child.exitCode, null);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.match(fs.readFileSync(resolveJobLogFile(root, job.id), 'utf8'), /not signalled/);
 } finally {
  child.stdin.end();
  await exited;
 }
});
