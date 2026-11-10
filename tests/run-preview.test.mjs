/** Oracles: the run preview contract. The recording fake observes the real foreground argv. */
import { it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFakeAgy } from './helpers/fake-agy.mjs';
import { resolveStateDir } from '../scripts/lib/state.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agy-preview-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const bin=path.resolve('bin/antigravity.mjs');
const touch=path.join(root,'spawned');
const fake=writeFakeAgy(root,'preview-agy',{versionOk:true,echoArgsStderr:true,touchFile:touch,
 modelsText:'flash-4-medium\tFlash\n',stdout:'{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n'});
// Tool markers cover yt-dlp and ffmpeg even if preview accidentally reaches mediaDoctor.
writeFakeAgy(root,'agy',{versionOk:true,touchFile:touch});
writeFakeAgy(root,'yt-dlp',{versionOk:true,touchFile:touch});
writeFakeAgy(root,'ffmpeg',{versionOk:true,touchFile:touch});
let seq=0;
function fixture(kind) {
 const dir=path.join(root,String(seq++));fs.mkdirSync(dir);
 const data=path.join(dir,'state');fs.mkdirSync(data);fs.writeFileSync(path.join(data,'sentinel'),'unchanged');
 const file=path.join(dir,kind==='vision'?'image.png':'clip.mp4'); fs.writeFileSync(file,'fixture');
 return {dir,data,args:kind==='vision'||kind==='media'?[file]:['Reply ok'],
 env:{...process.env,AGY_BIN:fake,CLAUDE_PLUGIN_DATA:data,PATH:root+path.delimiter+process.env.PATH,ANTIGRAVITY_NO_UPDATE_CHECK:'1'}};
}
function run(kind,args,f,env=f.env) {return spawnSync(process.execPath,[bin,kind,...args],{cwd:f.dir,env,encoding:'utf8',timeout:60000});}
function tree(dir) {return fs.readdirSync(dir,{recursive:true}).map(p=>{const file=path.join(dir,p); const stat=fs.statSync(file);return [p,stat.isDirectory()?'directory':fs.readFileSync(file,'base64')];});}
function redact(args) {const count=args.filter(a=>a==='--add-dir').length;return args.map((a,i)=>args[i-1]==='--add-dir'?String(count):a);}
for(const kind of ['task','rescue','vision','media']) {
 for(const modelFlags of [[],['--model','exact-id'],['--model-alias','flash']]) {
  it(`${kind} preview ${modelFlags.join(' ')||'default'} matches real argv and preserves the state tree`,()=>{
   const f=fixture(kind);const extra=kind==='task'||kind==='rescue'?['--add-dir',path.join(f.dir,'private-workspace')]:[];
   const args=[...f.args,...modelFlags,...extra];
   fs.rmSync(touch,{force:true});const before=tree(f.data);
   const preview=run(kind,[...args,'--preview','--json'],f);
   assert.equal(preview.status,0,preview.stderr);assert.equal(fs.existsSync(touch),false);
   assert.deepEqual(tree(f.data),before);
   const p=JSON.parse(preview.stdout);assert.equal(p.status,'preview');assert.equal(p.jobId,null);assert.equal(p.answer,null);
   assert.equal(preview.stdout.includes('private-workspace'),false);
   const text=run(kind,[...args,'--preview'],f);assert.equal(text.status,0,text.stderr);assert.equal(text.stdout.includes('private-workspace'),false);
   assert.equal(fs.existsSync(touch),false);assert.deepEqual(tree(f.data),before);
   const status=run('status',['--json'],f);assert.equal(status.status,0,status.stderr);const jobs=JSON.parse(status.stdout).details;assert.deepEqual(jobs.running,[]);assert.deepEqual(jobs.recent,[]);
   const real=run(kind,[...args,...(kind==='task'?['--foreground']:[]),'--json'],f);
   assert.equal(real.status,0,real.stderr);
   const jobId=JSON.parse(real.stdout).jobId;
   const job=JSON.parse(fs.readFileSync(path.join(resolveStateDir(f.dir,{CLAUDE_PLUGIN_DATA:f.data}),'jobs',jobId+'.json')));
   const actual=job.result.stderr.split(/\r?\n/).filter(l=>l.startsWith('arg=')).map(l=>l.slice(4));
   if(modelFlags[0]==='--model-alias') {
    actual[actual.indexOf('--model')+1]='<unresolved alias>';
    assert.equal(p.details.model,null);assert.equal(p.details.modelResolution,'unresolved');
    assert.match(p.details.modelResolutionNote,/agy models/);
   }
   assert.deepEqual(p.details.argv,redact(actual));
  });
 }
 for(const missing of [false,true]) it(`${kind} preview works without agy on PATH, missing AGY_BIN=${missing}`,()=>{
  const f=fixture(kind);const env={...f.env,PATH:''};delete env.AGY_BIN;if(missing)env.AGY_BIN=path.join(f.dir,'absent.exe');
  const res=run(kind,[...f.args,'--preview','--json'],f,env);assert.equal(res.status,0,res.stderr);assert.equal(JSON.parse(res.stdout).status,'preview');
 });
 const conflicts=kind==='task'?['background','wait','continue','conversation','request-id','show-result']:kind==='rescue'?['background','wait','continue','conversation','request-id','show-result','resume']:['background','wait','continue','conversation','request-id','show-result'];
 for(const flag of conflicts) it(`${kind} preview refuses --${flag}`,()=>{
  const f=fixture(kind); const res=run(kind,[...f.args,'--preview','--'+flag,...(['conversation','request-id'].includes(flag)?['id']:[])],f);
  assert.equal(res.status,1,res.stderr);assert.match(res.stderr,/cannot combine|unknown option|Unknown option|unknown flag/i);
 });
 it(`${kind} local validation errors keep the normal message and exit`,()=>{
  const f=fixture(kind);const args=kind==='media'?['https://evil.example/video']:[];
  const real=run(kind,[...args,'--json'],f);const preview=run(kind,[...args,'--json','--preview'],f);
  assert.equal(preview.status,real.status);assert.equal(preview.status,1);assert.equal(preview.stderr,real.stderr);assert.deepEqual(JSON.parse(preview.stdout),JSON.parse(real.stdout));
 });
}
it('YouTube preview reports mode, quality and video id without tools, downloads or state writes',()=>{
 const f=fixture('media');fs.rmSync(touch,{force:true});const before=tree(f.data);
 const result=run('media',['https://youtu.be/jNQXAC9IVRw','--preview','--json'],f);
 assert.equal(result.status,0,result.stderr);const p=JSON.parse(result.stdout);
 assert.equal(p.details.videoId,'jNQXAC9IVRw');assert.equal(p.details.mode,'video');assert.equal(p.details.quality,'360p');
 assert.match(p.details.prompt,/<downloaded media>/);assert.equal(fs.existsSync(touch),false);assert.deepEqual(tree(f.data),before);
});
it('transcript-only preview has no agy argv or prompt',()=>{
 const f=fixture('media');const r=run('media',['https://youtu.be/jNQXAC9IVRw','--transcript','--preview','--json'],f);
 assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);assert.deepEqual(p.details.argv,[]);assert.equal(p.details.prompt,null);assert.equal(p.details.agyCall,false);
});
// Oracle: preview keeps all existing local file, type and flag refusals.
for (const [kind,scenario] of [['vision','missing'],['vision','unsupported'],['vision','oversize'],
 ['media','missing'],['media','unsupported'],['media','oversize'],['media','local-flags']]) {
 it(`${kind} preview preserves the ${scenario} local refusal`,()=>{
  const f=fixture(kind);let file=f.args[0];
  if(scenario==='missing') file=path.join(f.dir,'missing.file');
  if(scenario==='unsupported') {file=path.join(f.dir,'unsupported.txt');fs.writeFileSync(file,'fixture');}
  if(scenario==='oversize')fs.truncateSync(file,100000001);
  const args=[file,...(scenario==='local-flags'?['--audio']:[]),'--json'];
  const real=run(kind,args,f),preview=run(kind,[...args,'--preview'],f);
  assert.equal(real.status,1,real.stderr);assert.equal(preview.status,1,preview.stderr);
  assert.equal(preview.stderr,real.stderr);assert.deepEqual(JSON.parse(preview.stdout),JSON.parse(real.stdout));
 });
}

// Oracle: only flags before -- may bypass the missing-AGY_BIN preflight.
// Media has no positional prompt after its file and no dispatcher AGY_BIN preflight.
for (const kind of ['task','rescue','vision']) {
 it(`${kind} --preview after -- keeps preflight exit 127 and never calls agy`,()=>{
  const f=fixture(kind);fs.rmSync(touch,{force:true});
  const result=run(kind,[...(kind==='task'?[]:f.args),'--','--preview'],f,{...f.env,AGY_BIN:path.join(f.dir,'absent.exe')});
  assert.equal(result.status,127,result.stderr);
  assert.match(result.stderr,/not found at AGY_BIN=/);
  assert.equal(fs.existsSync(touch),false);
 });
}
it('text preview escapes DEL and all C1 controls in the prompt',()=>{
 const f=fixture('task');const controls=String.fromCharCode(...Array.from({length:33},(_,i)=>127+i));
 const result=run('task',['Reply '+controls,'--preview'],f);
 assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/[\u007f-\u009f]/);
 const details=JSON.parse(result.stdout);assert.equal(details.prompt,'Reply '+controls);
});
// The quadratic redaction needed minutes for this input. The bound is wide so that a slow or
// loaded CI runner does not fail it: process start and a 512 KiB envelope took 1.8 s under load.
it('512 KiB unbroken prompt file previews in full within thirty seconds',()=>{
 const f=fixture('task');const file=path.join(f.dir,'prompt.txt');const prompt='a'.repeat(512*1024);
 fs.writeFileSync(file,prompt);const started=performance.now();
 const result=run('task',['--prompt-file',file,'--preview','--json'],f);
 const elapsed=performance.now()-started;console.log('preview 512 KiB ms:',elapsed);
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).details.prompt,prompt);
 assert.ok(elapsed<30000,`preview took ${elapsed} ms`);
});
