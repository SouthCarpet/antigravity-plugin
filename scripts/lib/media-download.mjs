import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeFailureReason } from './safe-reason.mjs';
import { terminateProcessTree } from './process.mjs';
import { ytDlpArgs, captionMetadataArgs, mediaError, localMedia, findTranscript, youtubeId } from './media.mjs';

async function runDownloader(bin, args, directory, deadline) {
  const child = spawn(bin, args, {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', diagnostic = '', timedOut = false, termination;
  const timer = setTimeout(() => {
    timedOut = true;
    termination = terminateProcessTree(child.pid);
  }, Math.max(1, deadline - Date.now()));
  child.stdout.on('data', (data) => { stdout = (stdout + data).slice(-16 * 1024 * 1024); });
  child.stderr.on('data', (data) => { diagnostic = (diagnostic + data).slice(-8192); });
  let exit;
  try {
    exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearTimeout(timer); await termination; }
  if (timedOut || exit !== 0) {
    const hint = /ffmpeg/i.test(diagnostic) ? ' Install ffmpeg, or use --quality 360p or --audio.' : '';
    const reason = safeFailureReason(diagnostic.split(/\r?\n/).filter(Boolean).at(-1));
    throw mediaError('download_failed', `YouTube download failed${timedOut ? ' (10-minute budget)' : ''}.${hint}${reason ? ' ' + reason : ''}`);
  }
  return stdout;
}

export async function downloadMedia({ bin, videoId, mode, quality, directory, timestamps = false, budgetMs = 600_000 }) {
  youtubeId(`https://www.youtube.com/watch?v=${videoId}`);
  const deadline = Date.now() + budgetMs;
  let subtitleLanguage = 'en';
  if (mode === 'transcript') {
    const metadata = await runDownloader(bin, captionMetadataArgs(videoId), directory, deadline);
    let info;
    try { info = JSON.parse(metadata); } catch { throw mediaError('download_failed', 'Could not read YouTube caption metadata.'); }
    if (/^[a-zA-Z0-9_-]+$/.test(info.language ?? '')) subtitleLanguage = info.language;
    const captions = { ...info.automatic_captions, ...info.subtitles };
    if (!captions[subtitleLanguage] && !captions.en) throw mediaError('transcript_unavailable', 'No original-language or English captions. Try --audio.');
    writeFileSync(join(directory, 'media.info.json'), JSON.stringify({ language: subtitleLanguage }));
  }
  await runDownloader(bin, ytDlpArgs({ videoId, mode, quality, directory, subtitleLanguage }), directory, deadline);
  if (mode === 'transcript') return findTranscript(directory, { timestamps });
  const name = readdirSync(directory).find((name) => /\.(mp4|m4a)$/.test(name));
  if (!name) throw mediaError('download_failed', 'No media file downloaded. It may exceed the size cap.');
  return localMedia(join(directory, name));
}
