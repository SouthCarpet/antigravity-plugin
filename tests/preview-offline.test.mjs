/** Oracle: B1 requires every preview to return before any process, download or state write. */
import { it, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
let spawns=0, downloads=0;
const forbiddenProcess=()=>{spawns++;throw new Error('Preview started a process');};
mock.module('node:child_process',{namedExports:{...childProcess,
 spawn:forbiddenProcess,spawnSync:forbiddenProcess,execFile:forbiddenProcess,execFileSync:forbiddenProcess,exec:forbiddenProcess,execSync:forbiddenProcess}});
mock.module('../scripts/lib/media-download.mjs',{namedExports:{downloadMedia:()=>{downloads++;throw new Error('Preview downloaded media');}}});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-preview-offline-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const originalData=process.env.CLAUDE_PLUGIN_DATA;
after(()=>{if(originalData===undefined)delete process.env.CLAUDE_PLUGIN_DATA;else process.env.CLAUDE_PLUGIN_DATA=originalData;});
for(const [kind,args] of [['task',['Reply ok']],['rescue',['Reply ok']],['vision',['image.png']],
 ['media',['https://youtu.be/jNQXAC9IVRw']]]) {
 it(`${kind} alias preview never starts a process or download and leaves an absent state root absent`,async()=>{
  fs.writeFileSync(path.join(root,'image.png'),'fixture');
  const data=path.join(root,kind+'-absent-state');process.env.CLAUDE_PLUGIN_DATA=data;
  const {run}=await import(`../scripts/commands/${kind}.mjs`);
  const out=[];const write=process.stdout.write;process.stdout.write=(s)=>{out.push(s);return true;};
  let code;try{code=await run([...args,'--model-alias','flash','--preview','--json'],{cwd:root});}finally{process.stdout.write=write;}
  assert.equal(code,0);assert.equal(JSON.parse(out.join('')).status,'preview');
  assert.equal(spawns,0);assert.equal(downloads,0);assert.equal(fs.existsSync(data),false);
 });
}
