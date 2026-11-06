import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeFakeAgy } from "./fake-agy.mjs";
export function writeFakeYtDlp(directory, options = {}) {
  return writeFakeAgy(directory, "yt-dlp", { versionOk: true, readStdin: false, ...options });
}
// A process-level fake: respects --paths and writes fixtures for the selected mode.
export function writeFixtureYtDlp(directory) {
  if (process.platform !== "win32") {
    const bin = path.join(directory, "yt-dlp");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs=require('fs'),p=require('path'),a=process.argv.slice(2);
if(a.includes('--version')){console.log('2026.10.26');process.exit(0)}
if(a.includes('--dump-single-json')){console.log(JSON.stringify({language:'en',subtitles:{en:[]}}));process.exit(0)}
fs.writeFileSync(p.join(__dirname,'argv.txt'),a.join('\\n'));
const d=a[a.indexOf('--paths')+1];fs.mkdirSync(d,{recursive:true});
if(a.includes('--skip-download'))
fs.writeFileSync(p.join(d,'media.en.vtt'),'WEBVTT\\n\\n00:00.000 --> 00:01.000\\npineapple\\n');
else
fs.writeFileSync(p.join(d,a.includes('bestaudio[ext=m4a]')?'media.m4a':'media.mp4'),'fixture');
`,
      { mode: 0o755 },
    );
    return bin;
  }
  const source = path.join(directory, "yt-dlp.cs"),
    bin = path.join(directory, "yt-dlp.exe");
  fs.writeFileSync(
    source,
    `using System; using System.IO;
class FakeYtDlp { static int Main(string[] a) {
 if(Array.IndexOf(a,"--version")>=0){Console.WriteLine("2026.10.26");return 0;}
 if(Array.IndexOf(a,"--dump-single-json")>=0){
 Console.WriteLine("{\\"language\\":\\"en\\",\\"subtitles\\":{\\"en\\":[]}}");return 0;}
 string home=Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
 File.WriteAllLines(Path.Combine(home,"argv.txt"),a);
 int n=Array.IndexOf(a,"--paths"); if(n<0)return 2; string d=a[n+1]; Directory.CreateDirectory(d);
 System.Threading.Thread.Sleep(200);
 if(Array.IndexOf(a,"--skip-download")>=0)
 File.WriteAllText(Path.Combine(d,"media.en.vtt"),"WEBVTT\\n\\n00:00.000 --> 00:01.000\\npineapple\\n");
 else {
 string name=Array.IndexOf(a,"bestaudio[ext=m4a]")>=0?"media.m4a":"media.mp4";
 File.WriteAllText(Path.Combine(d,name),"fixture");
 }
 return 0;
} }`,
  );
  const csc = path.join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  execFileSync(csc, ["/nologo", `/out:${bin}`, source]);
  return bin;
}
