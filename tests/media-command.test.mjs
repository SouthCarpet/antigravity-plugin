import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStdio } from './helpers/capture-stdio.mjs';
import { readJobFile } from '../scripts/lib/state.mjs';
const calls=[];
mock.module('../scripts/lib/agent-runtime.mjs',{namedExports:{runAgyPrint:async opts=>{calls.push(opts);return {status:'completed',exitCode:0,stdout:'## Transcription\npineapple\n## Answer\nAudio.',stderr:'',usage:{totalTokens:10,inputTokens:7,outputTokens:3},durationSeconds:1};},resolveAgyBin:()=> 'agy',probeAgy:async()=>({ok:true,version:'test'}),DEFAULT_AGY_BIN:'agy'}});
const {run}=await import('../scripts/commands/media.mjs');
// Oracle: media contract, local realpath grant and common envelope/provenance.
test('local wav reaches agy with only its directory granted and measured details', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-command-'));t.after(()=>{delete process.env.CLAUDE_PLUGIN_DATA;fs.rmSync(dir,{recursive:true,force:true});});
 process.env.CLAUDE_PLUGIN_DATA=path.join(dir,'data');const file=path.join(dir,'speech.wav');fs.writeFileSync(file,'audio');
 const cap=captureStdio();let code;try{code=await run([file,'--expect','pineapple','--json'],{cwd:dir});}finally{cap.restore();}
 assert.equal(code,0);const payload=JSON.parse(cap.out.join(''));assert.equal(payload.command,'media');assert.equal(payload.details.source,'local');assert.equal(payload.details.mimeType,'audio/wav');assert.equal(payload.details.bytes,5);assert.equal(payload.details.expectationSummary,'all_found');assert.equal(payload.details.durationSeconds,1);
 assert.deepEqual(calls[0].addDirs,[fs.realpathSync(dir)]);assert.equal(calls[0].model,'gemini-3.8-flash-high');assert.match(calls[0].prompt,/read_file/);
 const job=readJobFile(dir,payload.jobId);assert.equal(job.kind,'media');assert.equal(job.provenance.source,'local');assert.equal(job.provenance.mode,'audio');assert.equal(job.provenance.bytes,5);
});
for(const [name,input,expected] of [['missing file','absent.wav','media_not_found'],['unsupported extension','unknown.xyz','media_unsupported_type'],['playlist','https://youtube.com/playlist?list=x','youtube_url_invalid']]) test(`${name} returns media error envelope without agy`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-refusal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'unknown.xyz'),'x');const before=calls.length;const cap=captureStdio();let code;try{code=await run([input,'--json'],{cwd:dir});}finally{cap.restore();}assert.equal(code,1);assert.equal(JSON.parse(cap.out.join('')).details.error.code,expected);assert.equal(calls.length,before);
});

// Oracle: transcript-only must not spend model tokens; keep/cleanup apply to its files.
test('YouTube transcript returns plain text without agy and keeps only on request', async t=>{
 const {writeFixtureYtDlp}=await import('./helpers/fake-yt-dlp.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-transcript-'));const oldPath=process.env.PATH;const oldData=process.env.CLAUDE_PLUGIN_DATA;
 t.after(()=>{process.env.PATH=oldPath;if(oldData===undefined)delete process.env.CLAUDE_PLUGIN_DATA;else process.env.CLAUDE_PLUGIN_DATA=oldData;fs.rmSync(dir,{recursive:true,force:true});});
 writeFixtureYtDlp(dir);process.env.PATH=dir+path.delimiter+oldPath;process.env.CLAUDE_PLUGIN_DATA=path.join(dir,'data');
 const before=calls.length;const cap=captureStdio();let code;try{code=await run(['https://youtu.be/jNQXAC9IVRw','--transcript','--keep','--json'],{cwd:dir});}finally{cap.restore();}
 assert.equal(code,0,cap.err.join(''));const payload=JSON.parse(cap.out.join(''));assert.equal(payload.answer,'pineapple');assert.equal(calls.length,before);assert.equal(payload.details.usage,null);assert.equal(fs.existsSync(payload.details.mediaPath),true);
 const cap2=captureStdio();try{code=await run(['https://youtu.be/jNQXAC9IVRw','--transcript','--json'],{cwd:dir});}finally{cap2.restore();}
 assert.equal(code,0);const second=JSON.parse(cap2.out.join(''));assert.equal(fs.existsSync(second.details.mediaPath),false);assert.equal(calls.length,before);
});
