import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../scripts/lib/args.mjs';
import { MEDIA_SCHEMA, MEDIA_MIME, MEDIA_MAX_BYTES, youtubeId, localMedia, ytDlpArgs, transcriptText, cleanupMedia, findTranscript, mediaDoctor, validateLocalOptions } from '../scripts/lib/media.mjs';
import { downloadMedia } from '../scripts/lib/media-download.mjs';
import { writeFakeYtDlp } from './helpers/fake-yt-dlp.mjs';
// Oracle: the approved media contract. Each row states an independent input and outcome.
const cases = [
  ['audio conflicts with quality', ['--audio','--quality','480p']],
  ['transcript conflicts with quality', ['--transcript','--quality','360p']],
  ['transcript conflicts with audio', ['--transcript','--audio']],
  ['quality rejects 1080p', ['--quality','1080p']],
  ['empty expectations are refused', ['--expect',' ']],
  ['unknown flag refused', ['--background']],
];
for (const [name,args] of cases) test(name, () => assert.throws(() => parseArgs(args, MEDIA_SCHEMA)));
for (const flag of ['quality','audio','transcript','keep']) test(`local input refuses YouTube-only ${flag}`, () => assert.throws(() => validateLocalOptions({[flag]:true})));
for (const host of ['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com']) test(`${host} watch URL accepts one id`, () => assert.equal(youtubeId(`https://${host}/watch?v=jNQXAC9IVRw`),'jNQXAC9IVRw'));
test('short URL accepts one id', () => assert.equal(youtubeId('https://youtu.be/jNQXAC9IVRw'),'jNQXAC9IVRw'));
for (const url of ['https://evil.example/watch?v=jNQXAC9IVRw','https://youtube.com/playlist?list=x','https://youtube.com/watch?v=jNQXAC9IVRw&list=x','https://youtube.com/watch?v=x','https://youtube.com/watch?v=jNQXAC9IVRw&v=aaaaaaaaaaa','https://youtube.com.evil/watch?v=jNQXAC9IVRw','ftp://youtube.com/watch?v=jNQXAC9IVRw','https://u:p@youtube.com/watch?v=jNQXAC9IVRw','https://youtu.be/jNQXAC9IVRw/other']) test(`refuses ${url}`, () => assert.throws(() => youtubeId(url), { code:'youtube_url_invalid' }));
test('extension table matches the audio/video contract', () => assert.deepEqual(MEDIA_MIME, {'.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/opus','.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.m4v':'video/mp4'}));
function tmp(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'media-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('regular file accepts cap and refuses cap plus one',t=>{const dir=tmp(t),file=path.join(dir,'clip.mp4');fs.writeFileSync(file,'');fs.truncateSync(file,100000000);assert.equal(localMedia(file).bytes,100000000);fs.truncateSync(file,100000001);assert.throws(()=>localMedia(file),{code:'media_too_large'});assert.equal(MEDIA_MAX_BYTES,100000000);});
test('missing, directory and image inputs have named refusals',t=>{const dir=tmp(t),image=path.join(dir,'image.png');fs.writeFileSync(image,'x');assert.throws(()=>localMedia(path.join(dir,'missing.wav')),{code:'media_not_found'});assert.throws(()=>localMedia(dir),{code:'media_not_found'});assert.throws(()=>localMedia(image),{code:'media_unsupported_type'});});
for (const [quality,format] of [
 ['360p','best[ext=mp4][height<=360]/bestvideo[ext=mp4][height<=360]+bestaudio[ext=m4a]'],
 ['480p','bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]'],
 ['720p','bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]'],
]) test(`${quality} uses exact safe argv`,()=>assert.deepEqual(ytDlpArgs({videoId:'jNQXAC9IVRw',mode:'video',quality,directory:'scratch dir'}),['--ignore-config','--no-playlist','--max-filesize','100000000','--paths','scratch dir','--output','media.%(ext)s','--print','after_move:filepath','--format',format,'--merge-output-format','mp4','--','https://www.youtube.com/watch?v=jNQXAC9IVRw']));
test('audio uses exact safe argv',()=>assert.deepEqual(ytDlpArgs({videoId:'jNQXAC9IVRw',mode:'audio',directory:'scratch dir'}),['--ignore-config','--no-playlist','--max-filesize','100000000','--paths','scratch dir','--output','media.%(ext)s','--print','after_move:filepath','--format','bestaudio[ext=m4a]','--','https://www.youtube.com/watch?v=jNQXAC9IVRw']));
test('transcript uses exact safe argv',()=>assert.deepEqual(ytDlpArgs({videoId:'jNQXAC9IVRw',mode:'transcript',directory:'scratch dir'}),['--ignore-config','--no-playlist','--max-filesize','100000000','--paths','scratch dir','--output','media.%(ext)s','--print','after_move:filepath','--skip-download','--write-subs','--write-auto-subs','--sub-langs','en,en','--write-info-json','--sub-format','vtt/srt','--','https://www.youtube.com/watch?v=jNQXAC9IVRw']));
test('VTT and SRT remove timestamps and tags',()=>{assert.equal(transcriptText('WEBVTT\n\n00:00.000 --> 00:01.000\nHello <b>world</b>\nHello world\n'),'Hello world');assert.equal(transcriptText('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld'),'Hello\nWorld');});
test('cleanup deletes default files and keeps opted-in files',t=>{const dir=tmp(t),child=path.join(dir,'download');fs.mkdirSync(child);fs.writeFileSync(path.join(child,'media.mp4'),'x');cleanupMedia(child,true);assert.equal(fs.existsSync(child),true);cleanupMedia(child,false);assert.equal(fs.existsSync(child),false);});
test('captions prefer original language over English',t=>{const dir=tmp(t);fs.writeFileSync(path.join(dir,'media.info.json'),JSON.stringify({language:'sk'}));fs.writeFileSync(path.join(dir,'media.sk.vtt'),'WEBVTT\n\nAhoj');fs.writeFileSync(path.join(dir,'media.en.vtt'),'WEBVTT\n\nHello');assert.equal(findTranscript(dir).text,'Ahoj');});
test('missing captions name audio remedy',t=>assert.throws(()=>findTranscript(tmp(t)),{code:'transcript_unavailable'}));
test('fake yt-dlp downloads one local fixture without network',async t=>{const dir=tmp(t);const bin=writeFakeYtDlp(dir,{touchFile:path.join(dir,'media.mp4')});const result=await downloadMedia({bin,videoId:'jNQXAC9IVRw',mode:'video',quality:'360p',directory:dir});assert.equal(result.mimeType,'video/mp4');assert.equal(result.bytes,0);});
test('fake yt-dlp failure has download error',async t=>{const dir=tmp(t);const bin=writeFakeYtDlp(dir,{exitCode:1});await assert.rejects(downloadMedia({bin,videoId:'jNQXAC9IVRw',mode:'video',directory:dir}),{code:'download_failed'});});
test('doctor without optional tools reports absent and cap',()=>{const result=mediaDoctor({...process.env,PATH:''});assert.deepEqual(result,{ytDlp:{path:'absent',version:'absent'},ffmpeg:{path:'absent'},sizeCapBytes:100000000});});

for (const form of ['shorts','embed','live']) test(`${form} URL accepts one video id`,()=>assert.equal(youtubeId(`https://youtube.com/${form}/jNQXAC9IVRw`),'jNQXAC9IVRw'));
test('path video with second query id is refused',()=>assert.throws(()=>youtubeId('https://youtube.com/shorts/jNQXAC9IVRw?v=aaaaaaaaaaa'),{code:'youtube_url_invalid'}));

test('transcript retains a repeated line after intervening speech (caption content oracle)',()=>assert.equal(transcriptText('WEBVTT\n\n00:00.000 --> 00:01.000\nYes\n\n00:01.000 --> 00:02.000\nNo\n\n00:02.000 --> 00:03.000\nYes'),'Yes\nNo\nYes'));
