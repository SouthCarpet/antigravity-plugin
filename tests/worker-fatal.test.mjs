import { removeTestDir } from './helpers/tmp.mjs';
// Regressions for the worker and state-save guarantees in docs/COMPATIBILITY.md.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { patchJob } from '../scripts/lib/job-helpers.mjs';
import { resolveJobLogFile, readJobFile } from '../scripts/lib/state.mjs';
const saved=process.env.CLAUDE_PLUGIN_DATA;let root;
afterEach(()=>{if(saved===undefined)delete process.env.CLAUDE_PLUGIN_DATA;else process.env.CLAUDE_PLUGIN_DATA=saved;if(root)removeTestDir(root);});
async function fixture(){root=fs.mkdtempSync(path.join(os.tmpdir(),'antigravity-fatal-'));process.env.CLAUDE_PLUGIN_DATA=root;await patchJob(root,'abcdefabcdef',{status:'running',request:{prompt:'test'}});return root;}
test('runtime stderr is bounded and redacts OAuth URLs and bypass flags',async()=>{
 await fixture();const entry=path.join(root,'noisy.mjs');
 const message='failure https://accounts.google.com/o/oauth2/auth?code=secret --dangerously-skip-permissions accounts.google.com/o/oauth2 --ｄａｎｇｅｒｏｕｓｌｙ-ｓｋｉｐ-ｐｅｒｍｉｓｓｉｏｎｓ ａｃｃｏｕｎｔｓ.google.com/o/oauth2\n';
 fs.writeFileSync(entry,'for(let n=0;n<10000;n++)process.stderr.write('+JSON.stringify(message)+');');
 const result=spawnSync(process.execPath,['--import',new URL('../scripts/lib/worker-diagnostics.mjs',import.meta.url).href,entry,'abcdefabcdef',root],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0);const log=fs.readFileSync(resolveJobLogFile(root,'abcdefabcdef'),'utf8');assert.match(log,/failure/);assert.doesNotMatch(log,/secret|--dangerously-skip-permissions|accounts\.google/);assert.ok(Buffer.byteLength(log)<=65536);assert.ok(Buffer.byteLength(log)>64000);
});
test('a module import failure reaches the job log before worker handlers load',async()=>{
 await fixture();const entry=path.join(root,'broken.mjs');fs.writeFileSync(entry,"import './missing-worker-module.mjs';");
 const result=spawnSync(process.execPath,['--import',new URL('../scripts/lib/worker-diagnostics.mjs',import.meta.url).href,entry,'abcdefabcdef',root],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,1);assert.match(fs.readFileSync(resolveJobLogFile(root,'abcdefabcdef'),'utf8'),/Cannot find module/);
});
test('a failed final write logs the fatal reason and records failed when storage recovers',async()=>{
 await fixture();const inject=path.join(root,'inject.mjs');
 const helpers=new URL('../scripts/lib/job-helpers.mjs',import.meta.url).href;
 const runtime=new URL('../scripts/lib/agent-runtime.mjs',import.meta.url).href;
 fs.writeFileSync(inject,`import {mock} from 'node:test'; const h=await import(${JSON.stringify(helpers)}); const r=await import(${JSON.stringify(runtime)}); let failed=false; mock.module(${JSON.stringify(helpers)},{namedExports:{...h,patchJob:async(...args)=>{if(args[2].status==='completed'&&!failed){failed=true;throw new Error('final rename failed');}return h.patchJob(...args);}}}); mock.module(${JSON.stringify(runtime)},{namedExports:{...r,runAgyPrint:async()=>({status:'completed',exitCode:0,stdout:'answer',stderr:''})}});`);
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--import',pathToFileURL(inject).href,'--import',new URL('../scripts/lib/worker-diagnostics.mjs',import.meta.url).href,fileURLToPath(new URL('../scripts/commands/_worker.mjs',import.meta.url)),'abcdefabcdef',root],{encoding:'utf8',timeout:20000});
 assert.equal(result.status,1,result.stderr);assert.match(fs.readFileSync(resolveJobLogFile(root,'abcdefabcdef'),'utf8'),/final rename failed/);assert.equal(readJobFile(root,'abcdefabcdef').status,'failed');assert.equal(readJobFile(root,'abcdefabcdef').errorMessage,'final rename failed');
});



test('the launcher exits while its detached worker is still running',async()=>{
 await fixture();const {writeFakeAgy}=await import('./helpers/fake-agy.mjs');const {waitForJob}=await import('../scripts/lib/job-helpers.mjs');
 const fake=writeFakeAgy(root,'agy-detached',{stdout:JSON.stringify({event:'result',result:{status:'SUCCESS',response:'done'}})+'\n',exitCode:0,versionOk:true,delayMs:20000});
 const script=`import {startBackgroundJob} from ${JSON.stringify(new URL('../scripts/lib/job-helpers.mjs',import.meta.url).href)}; const launched=await startBackgroundJob({workspaceRoot:${JSON.stringify(root)},kind:'task',prompt:'go',env:{...process.env,AGY_BIN:${JSON.stringify(fake)}}});console.log(JSON.stringify(launched));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);const launched=JSON.parse(result.stdout);assert.ok(launched.pid);assert.doesNotThrow(()=>process.kill(launched.pid,0));
 const final=await waitForJob(root,launched.job.id,{pollMs:100,timeoutMs:30000});assert.equal(final.status,'completed');
 const deadline=Date.now()+5000;
 let alive=true;
 while(alive && Date.now()<deadline){
  try{process.kill(launched.pid,0);}catch{alive=false;}
  if(alive)await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(alive,false,'worker exits before fixture cleanup');
});


test('an uncaught runtime exception reaches the job log',async()=>{
 await fixture();const entry=path.join(root,'uncaught.mjs');fs.writeFileSync(entry,"setImmediate(() => { throw new Error('uncaught worker failure'); });");
 const result=spawnSync(process.execPath,['--import',new URL('../scripts/lib/worker-diagnostics.mjs',import.meta.url).href,entry,'abcdefabcdef',root],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,1);assert.match(fs.readFileSync(resolveJobLogFile(root,'abcdefabcdef'),'utf8'),/uncaught worker failure/);
});

test('fatal recovery redacts OAuth URLs and bypass flags in the stored reason',async()=>{
 await fixture();
 const { recordWorkerFatal } = await import('../scripts/lib/worker-failure.mjs');
 await recordWorkerFatal(root,'abcdefabcdef',new Error('fatal at https://accounts.google.com/o/oauth2/auth?code=secret --dangerously-skip-permissions'));
 const stored=readJobFile(root,'abcdefabcdef');
 assert.equal(stored.status,'failed');
 assert.equal(stored.errorMessage,'fatal at [oauth-url-removed] [flag redacted]');
 const log=fs.readFileSync(resolveJobLogFile(root,'abcdefabcdef'),'utf8');
 assert.doesNotMatch(log,/secret|accounts\.google|--dangerously-skip-permissions/);
});

test('fatal recovery redacts a bypass flag exposed by text normalization',async()=>{
 await fixture();
 const { recordWorkerFatal } = await import('../scripts/lib/worker-failure.mjs');
 await recordWorkerFatal(root,'abcdefabcdef',new Error('fatal --ｄａｎｇｅｒｏｕｓｌｙ-ｓｋｉｐ-ｐｅｒｍｉｓｓｉｏｎｓ'));
 assert.equal(readJobFile(root,'abcdefabcdef').errorMessage,'fatal [flag redacted]');
});

test('fatal recovery removes an OAuth URL exposed by text normalization',async()=>{
 await fixture();
 const { recordWorkerFatal } = await import('../scripts/lib/worker-failure.mjs');
 await recordWorkerFatal(root,'abcdefabcdef',new Error('fatal ａｃｃｏｕｎｔｓ.google.com/o/oauth2'));
 assert.equal(readJobFile(root,'abcdefabcdef').errorMessage,'fatal [oauth-url-removed]');
});
