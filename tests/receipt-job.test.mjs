/** Ruling 4: help failure never changes the foreground job exit or result. */
import {it,mock,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn as realSpawn, spawnSync as realSpawnSync} from 'node:child_process';
import {writeFakeAgy} from './helpers/fake-agy.mjs';
import {portableTmpRoot,removeTestDir} from './helpers/tmp.mjs';
const root=fs.mkdtempSync(path.join(portableTmpRoot(),'listed-flags-job-'));
after(()=>removeTestDir(root));
const fake=writeFakeAgy(root,'job',{versionOk:true,stdout:'{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n'});
const slowFake=writeFakeAgy(root,'slow-job',{versionOk:true,delayMs:1500,stdout:'{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n'});
let result;
let helpCalls=0;
mock.module('../scripts/lib/process-adapter.mjs',{namedExports:{spawn:realSpawn,spawnSync:(bin,argv,options)=>{assert.deepEqual(argv,['--help']);helpCalls++;return result==='real' ? realSpawnSync(bin,argv,options) : result;}}});
const {run}=await import('../scripts/commands/task.mjs');
const {readJobFile}=await import('../scripts/lib/state.mjs');
for(const [name,value] of [['real timeout','real'],['spawn error',{error:new Error('failed')}],['nonzero',{status:1,stdout:'--model'}],['empty',{status:0,stdout:''}],['timeout',{status:null,error:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})}]]){
 it(`${name} help still completes task with exit 0 and null listing (ruling 4)`,async()=>{
  result=value;helpCalls=0;
  const savedBin=process.env.AGY_BIN,savedData=process.env.CLAUDE_PLUGIN_DATA;
  process.env.AGY_BIN=result==='real'?slowFake:fake;process.env.CLAUDE_PLUGIN_DATA=path.join(root,'state');
  let text='';const out=process.stdout.write,err=process.stderr.write;
  process.stdout.write=(chunk,...rest)=>{if(typeof chunk!=='string')return out.call(process.stdout,chunk,...rest);text+=chunk;return true;};
  process.stderr.write=(chunk,...rest)=>typeof chunk==='string'?true:err.call(process.stderr,chunk,...rest);
  let code;
  try{code=await run(['Reply done','--foreground','--json'],{cwd:root});}
  finally{process.stdout.write=out;process.stderr.write=err;if(savedBin===undefined)delete process.env.AGY_BIN;else process.env.AGY_BIN=savedBin;if(savedData===undefined)delete process.env.CLAUDE_PLUGIN_DATA;else process.env.CLAUDE_PLUGIN_DATA=savedData;}
  assert.equal(code,0,text);const payload=JSON.parse(text);assert.equal(payload.status,'completed');assert.equal(helpCalls,1);
  // Read with the same state root used by the command.
  const prior=process.env.CLAUDE_PLUGIN_DATA;process.env.CLAUDE_PLUGIN_DATA=path.join(root,'state');
  try{assert.equal(readJobFile(root,payload.jobId).provenance.listedFlags,null);}finally{if(prior===undefined)delete process.env.CLAUDE_PLUGIN_DATA;else process.env.CLAUDE_PLUGIN_DATA=prior;}
 });
}
