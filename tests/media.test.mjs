import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../scripts/lib/args.mjs";
import {
  MEDIA_SCHEMA,
  MEDIA_MIME,
  MEDIA_MAX_BYTES,
  youtubeId,
  localMedia,
  ytDlpArgs,
  transcriptText,
  cleanupMedia,
  findTranscript,
  mediaDoctor,
  validateLocalOptions,
} from "../scripts/lib/media.mjs";
import { downloadMedia } from "../scripts/lib/media-download.mjs";
import { writeFakeYtDlp } from "./helpers/fake-yt-dlp.mjs";
// Oracle: the approved media contract. Each row states an independent input and outcome.
const cases = [
  ["audio conflicts with quality", ["--audio", "--quality", "480p"]],
  ["transcript conflicts with quality", ["--transcript", "--quality", "360p"]],
  ["transcript conflicts with audio", ["--transcript", "--audio"]],
  ["quality rejects 1080p", ["--quality", "1080p"]],
  ["empty expectations are refused", ["--expect", " "]],
  ["unknown flag refused", ["--background"]],
];
for (const [name, args] of cases) test(name, () => assert.throws(() => parseArgs(args, MEDIA_SCHEMA)));
for (const flag of ["quality", "audio", "transcript", "keep"])
  test(`local input refuses YouTube-only ${flag}`, () =>
    assert.throws(() => validateLocalOptions({ [flag]: true })));
for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"])
  test(`${host} watch URL accepts one id`, () =>
    assert.equal(youtubeId(`https://${host}/watch?v=jNQXAC9IVRw`), "jNQXAC9IVRw"));
test("short URL accepts one id", () =>
  assert.equal(youtubeId("https://youtu.be/jNQXAC9IVRw"), "jNQXAC9IVRw"));
for (const url of [
  "https://evil.example/watch?v=jNQXAC9IVRw",
  "https://youtube.com/playlist?list=x",
  "https://youtube.com/watch?v=jNQXAC9IVRw&list=x",
  "https://youtube.com/watch?v=x",
  "https://youtube.com/watch?v=jNQXAC9IVRw&v=aaaaaaaaaaa",
  "https://youtube.com.evil/watch?v=jNQXAC9IVRw",
  "ftp://youtube.com/watch?v=jNQXAC9IVRw",
  "https://u:p@youtube.com/watch?v=jNQXAC9IVRw",
  "https://youtu.be/jNQXAC9IVRw/other",
])
  test(`refuses ${url}`, () => assert.throws(() => youtubeId(url), { code: "youtube_url_invalid" }));
test("extension table matches the audio/video contract", () =>
  assert.deepEqual(MEDIA_MIME, {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".m4v": "video/mp4",
  }));
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("regular file accepts cap and refuses cap plus one", (t) => {
  const dir = tmp(t),
    file = path.join(dir, "clip.mp4");
  fs.writeFileSync(file, "");
  fs.truncateSync(file, 100000000);
  assert.equal(localMedia(file).bytes, 100000000);
  fs.truncateSync(file, 100000001);
  assert.throws(() => localMedia(file), { code: "media_too_large" });
  assert.equal(MEDIA_MAX_BYTES, 100000000);
});
test("missing, directory and image inputs have named refusals", (t) => {
  const dir = tmp(t),
    image = path.join(dir, "image.png");
  fs.writeFileSync(image, "x");
  assert.throws(() => localMedia(path.join(dir, "missing.wav")), { code: "media_not_found" });
  assert.throws(() => localMedia(dir), { code: "media_not_found" });
  assert.throws(() => localMedia(image), { code: "media_unsupported_type" });
});
for (const [quality, format] of [
  ["360p", "best[ext=mp4][height<=360]/bestvideo[ext=mp4][height<=360]+bestaudio[ext=m4a]"],
  ["480p", "bestvideo[ext=mp4][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]"],
  ["720p", "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]"],
])
  test(`${quality} uses exact safe argv`, () =>
    assert.deepEqual(
      ytDlpArgs({ videoId: "jNQXAC9IVRw", mode: "video", quality, directory: "scratch dir" }),
      [
        "--ignore-config",
        "--no-playlist",
        "--max-filesize",
        "100000000",
        "--paths",
        "scratch dir",
        "--output",
        "media.%(ext)s",
        "--print",
        "after_move:filepath",
        "--format",
        format,
        "--merge-output-format",
        "mp4",
        "--",
        "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      ],
    ));
test("audio uses exact safe argv", () =>
  assert.deepEqual(ytDlpArgs({ videoId: "jNQXAC9IVRw", mode: "audio", directory: "scratch dir" }), [
    "--ignore-config",
    "--no-playlist",
    "--max-filesize",
    "100000000",
    "--paths",
    "scratch dir",
    "--output",
    "media.%(ext)s",
    "--print",
    "after_move:filepath",
    "--format",
    "bestaudio[ext=m4a]",
    "--",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  ]));
test("transcript uses exact safe argv", () =>
  assert.deepEqual(ytDlpArgs({ videoId: "jNQXAC9IVRw", mode: "transcript", directory: "scratch dir" }), [
    "--ignore-config",
    "--no-playlist",
    "--max-filesize",
    "100000000",
    "--paths",
    "scratch dir",
    "--output",
    "media.%(ext)s",
    "--print",
    "after_move:filepath",
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en,en",
    "--write-info-json",
    "--sub-format",
    "vtt/srt",
    "--",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  ]));
test("VTT and SRT remove timestamps and tags", () => {
  assert.equal(
    transcriptText("WEBVTT\n\n00:00.000 --> 00:01.000\nHello <b>world</b>\nHello world\n"),
    "Hello world",
  );
  assert.equal(
    transcriptText("1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:02,000 --> 00:00:03,000\nWorld"),
    "Hello\nWorld",
  );
});
// Oracle: plan 150 fix-2 caption conversion contract; each case pins plain-text output.
test("nested entity spelling decodes only once", () =>
  assert.equal(transcriptText("&amp;lt;b&amp;gt;"), "&lt;b&gt;"));

test("malformed nested tags leave no angle brackets and retain speech", () =>
  assert.equal(transcriptText("<<b>script>alert(1)</b>"), "alert(1)"));

test("VTT class, timestamp and voice tags leave only speech", () =>
  assert.equal(transcriptText("<c.yellow><00:00:01.500>Hello</c> <v Jawed>world</v>"), "Hello world"));

test("SRT comma timing and VTT cue settings are dropped", () =>
  assert.equal(
    transcriptText("00:00:01,000 --> 00:00:02,000\n00:01.000 --> 00:02.000 align:start position:0%\nHello"),
    "Hello",
  ));

test("speech containing a timing arrow is kept", () =>
  assert.equal(transcriptText("A --> B is an arrow"), "A -- B is an arrow"));

test("bare cue numbers are dropped while numbers with speech are kept", () =>
  assert.equal(transcriptText("12\n12 elephants"), "12 elephants"));

test("cleanup deletes default files and keeps opted-in files", (t) => {
  const dir = tmp(t),
    child = path.join(dir, "download");
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, "media.mp4"), "x");
  cleanupMedia(child, true);
  assert.equal(fs.existsSync(child), true);
  cleanupMedia(child, false);
  assert.equal(fs.existsSync(child), false);
});
test("captions prefer original language over English", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "media.info.json"), JSON.stringify({ language: "sk" }));
  fs.writeFileSync(path.join(dir, "media.sk.vtt"), "WEBVTT\n\nAhoj");
  fs.writeFileSync(path.join(dir, "media.en.vtt"), "WEBVTT\n\nHello");
  assert.equal(findTranscript(dir).text, "Ahoj");
});
test("missing captions name audio remedy", (t) =>
  assert.throws(() => findTranscript(tmp(t)), { code: "transcript_unavailable" }));
test("fake yt-dlp downloads one local fixture without network", async (t) => {
  const dir = tmp(t);
  const bin = writeFakeYtDlp(dir, { touchFile: path.join(dir, "media.mp4") });
  const result = await downloadMedia({
    bin,
    videoId: "jNQXAC9IVRw",
    mode: "video",
    quality: "360p",
    directory: dir,
  });
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(result.bytes, 0);
});
test("fake yt-dlp failure has download error", async (t) => {
  const dir = tmp(t);
  const bin = writeFakeYtDlp(dir, { exitCode: 1 });
  await assert.rejects(downloadMedia({ bin, videoId: "jNQXAC9IVRw", mode: "video", directory: dir }), {
    code: "download_failed",
  });
});
test("doctor without optional tools reports absent and cap", () => {
  const result = mediaDoctor({ ...process.env, PATH: "" });
  assert.deepEqual(result, {
    ytDlp: { path: "absent", version: "absent" },
    ffmpeg: { path: "absent" },
    sizeCapBytes: 100000000,
  });
});

for (const form of ["shorts", "embed", "live"])
  test(`${form} URL accepts one video id`, () =>
    assert.equal(youtubeId(`https://youtube.com/${form}/jNQXAC9IVRw`), "jNQXAC9IVRw"));
test("path video with second query id is refused", () =>
  assert.throws(() => youtubeId("https://youtube.com/shorts/jNQXAC9IVRw?v=aaaaaaaaaaa"), {
    code: "youtube_url_invalid",
  }));

test("transcript retains a repeated line after intervening speech (caption content oracle)", () =>
  assert.equal(
    transcriptText(
      "WEBVTT\n\n00:00.000 --> 00:01.000\nYes\n\n00:01.000 --> 00:02.000\nNo\n\n00:02.000 --> 00:03.000\nYes",
    ),
    "Yes\nNo\nYes",
  ));

// Oracle: approved media contract, default video selection and caption metadata safety.
test("omitted quality selects the exact 360p argv", () => {
  assert.deepEqual(ytDlpArgs({ videoId: "jNQXAC9IVRw", mode: "video", directory: "scratch" }), [
    "--ignore-config",
    "--no-playlist",
    "--max-filesize",
    "100000000",
    "--paths",
    "scratch",
    "--output",
    "media.%(ext)s",
    "--print",
    "after_move:filepath",
    "--format",
    "best[ext=mp4][height<=360]/bestvideo[ext=mp4][height<=360]+bestaudio[ext=m4a]",
    "--merge-output-format",
    "mp4",
    "--",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  ]);
});
test("caption metadata skips all downloads and refuses playlists", async () => {
  const { captionMetadataArgs } = await import("../scripts/lib/media.mjs");
  assert.deepEqual(captionMetadataArgs("jNQXAC9IVRw"), [
    "--ignore-config",
    "--no-playlist",
    "--skip-download",
    "--dump-single-json",
    "--",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  ]);
});
test("doctor reports the installed fake downloader path and version", async (t) => {
  const { writeFixtureYtDlp } = await import("./helpers/fake-yt-dlp.mjs");
  const dir = tmp(t);
  const bin = writeFixtureYtDlp(dir);
  const result = mediaDoctor({ ...process.env, PATH: dir + path.delimiter + process.env.PATH });
  assert.equal(result.ytDlp.path, bin);
  assert.equal(result.ytDlp.version, "2026.10.26");
});
test("download deadline terminates a sleeping downloader", async (t) => {
  const dir = tmp(t);
  const bin = writeFakeYtDlp(dir, { delayMs: 30000, versionOk: false, stdout: "started" });
  await assert.rejects(
    downloadMedia({ bin, videoId: "jNQXAC9IVRw", mode: "video", directory: dir, budgetMs: 200 }),
    { code: "download_failed", message: /10-minute budget/ },
  );
});

// Oracle: deadline must remove the downloader and its child, not just return an error.
test(
  "download budget removes the real Windows process tree",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const dir = tmp(t);
    const bin = path.join(dir, "sleep.exe");
    const source = path.join(dir, "sleep.cs");
    fs.writeFileSync(
      source,
      `using System; using System.IO; using System.Diagnostics;
class Sleeper { static void Main(string[] args) {
 string exe=Process.GetCurrentProcess().MainModule.FileName;
 if(args.Length==1 && args[0]=="child"){System.Threading.Thread.Sleep(30000);return;}
 var child=Process.Start(new ProcessStartInfo(exe,"child"){UseShellExecute=false,CreateNoWindow=true});
 File.WriteAllText(Path.Combine(Path.GetDirectoryName(exe),"pids.txt"),
 Process.GetCurrentProcess().Id+"\\n"+child.Id);
 System.Threading.Thread.Sleep(30000);
} }`,
    );
    execFileSync(path.join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), [
      "/nologo",
      `/out:${bin}`,
      source,
    ]);
    await assert.rejects(
      downloadMedia({ bin, videoId: "jNQXAC9IVRw", mode: "video", directory: dir, budgetMs: 1500 }),
      { code: "download_failed", message: /10-minute budget/ },
    );
    const [parent, child] = fs.readFileSync(path.join(dir, "pids.txt"), "utf8").split("\n").map(Number);
    assert.throws(() => process.kill(parent, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  },
);
