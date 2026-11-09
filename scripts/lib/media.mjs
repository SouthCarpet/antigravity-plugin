import { realpathSync, statSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ArgsError } from './args.mjs';
import { validateExpectOption } from './vision-expect.mjs';

export const MEDIA_MAX_BYTES = 100_000_000;
export const MEDIA_MIME = Object.freeze({
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.m4v': 'video/mp4',
});
export const MEDIA_SCHEMA = {
  valueOptions: ['prompt', 'model', 'model-alias', 'cwd', 'quality', 'output'],
  booleanOptions: ['preview', 'json', 'audio', 'transcript', 'keep', 'timestamps'], repeatableOptions: ['expect'],
  valueChoices: { quality: ['360p', '480p', '720p'] },
  conflicts: [['model', 'model-alias'], ['audio', 'quality'], ['transcript', 'quality'], ['transcript', 'audio']],
  validate: validateMediaOptions,
};

function validateMediaOptions(options) {
  if (options.timestamps && !options.transcript) throw new ArgsError('--timestamps requires --transcript');
  validateExpectOption(options);
}

export function mediaError(code, message) { return Object.assign(new Error(message), { code }); }

export function youtubeId(input) {
  let url;
  try { url = new URL(input); } catch { throw mediaError('youtube_url_invalid', 'Use one YouTube video URL.'); }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
  if (!hosts.includes(url.hostname) || !['https:', 'http:'].includes(url.protocol) ||
      url.username || url.password || url.port || url.searchParams.has('list')) {
    throw mediaError('youtube_url_invalid', 'Only a YouTube video URL is allowed; playlists are refused.');
  }
  const pathId = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : pathId ?? url.searchParams.get('v');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id ?? '') ||
      (url.hostname !== 'youtu.be' && url.pathname !== '/watch' && !pathId) ||
      (pathId && url.searchParams.has('v')) || url.searchParams.getAll('v').length > 1) {
    throw mediaError('youtube_url_invalid', 'Use one YouTube video id, without a playlist.');
  }
  return id;
}

export function localMedia(file) {
  let path, stat;
  try { path = realpathSync(file); stat = statSync(path); }
  catch { throw mediaError('media_not_found', `Media file not found: ${file}`); }
  if (!stat.isFile()) throw mediaError('media_not_found', `Not a regular media file: ${file}`);
  const mimeType = MEDIA_MIME[extname(path).toLowerCase()];
  if (!mimeType) throw mediaError('media_unsupported_type', 'Unsupported media type. Use vision for images.');
  if (stat.size > MEDIA_MAX_BYTES) throw mediaError('media_too_large', `Media exceeds ${MEDIA_MAX_BYTES} bytes.`);
  return { mediaPath: path, mimeType, bytes: stat.size, mode: mimeType.startsWith('audio/') ? 'audio' : 'video' };
}

export function validateLocalOptions(options) {
  if (['quality', 'audio', 'transcript', 'keep'].some((key) => options[key] !== undefined)) {
    throw new ArgsError('--quality, --audio, --transcript and --keep apply only to YouTube URLs.');
  }
}

export function ytDlpArgs({ videoId, mode, quality = '360p', directory, subtitleLanguage = 'en' }) {
  const args = ['--ignore-config', '--no-playlist', '--max-filesize', String(MEDIA_MAX_BYTES),
    '--paths', directory, '--output', 'media.%(ext)s', '--print', 'after_move:filepath'];
  if (mode === 'transcript') args.push('--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', `${subtitleLanguage},en`, '--write-info-json', '--sub-format', 'vtt/srt');
  else if (mode === 'audio') args.push('--format', 'bestaudio[ext=m4a]');
  else {
    const height = quality.slice(0, -1);
    const combined = `best[ext=mp4][height<=${height}]`;
    const separate = `bestvideo[ext=mp4][height<=${height}]+bestaudio[ext=m4a]`;
    args.push('--format', quality === '360p' ? `${combined}/${separate}` : `${separate}/${combined}`, '--merge-output-format', 'mp4');
  }
  return [...args, '--', `https://www.youtube.com/watch?v=${videoId}`];
}

function isCaptionSpeech(line) {
  const timing = /^(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\b/.test(line) && line.includes('-->');
  return !timing && !/^(?:WEBVTT|Kind:|Language:|NOTE|STYLE|Region:|\d+$)/.test(line);
}

const CAPTION_ENTITIES = Object.freeze({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
});

function cleanCaptionLine(line) {
  // Captions become plain text for terminals or model prompts, never HTML.
  let previous;
  do {
    previous = line;
    line = line.replace(/<[^<>]*>/g, '');
  } while (line !== previous);
  return line.replace(/[<>]/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => CAPTION_ENTITIES[entity]).trim();
}

export function transcriptText(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim())
    .filter(isCaptionSpeech).map(cleanCaptionLine).filter(Boolean);
  return lines.filter((line, index) => index === 0 || line !== lines[index - 1]).join('\n');
}

const CUE_LINE_START = /^\d+:\d+(?::\d+)?[.,]\d+/;
const CUE_START_TIME = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,]\d{1,3}$/;
const UNKNOWN_CLOCK = '--:--:--';

// Start of a cue line in whole seconds, floored. `undefined`: not a cue line.
// `null`: a cue line whose start time is malformed or above 99 hours.
function cueStartSeconds(line) {
  const arrow = line.indexOf('-->');
  if (arrow < 0 || !CUE_LINE_START.test(line)) return undefined;
  const match = CUE_START_TIME.exec(line.slice(0, arrow).trim());
  if (!match) return null;
  const [hours, minutes, seconds] = [match[1] ?? '0', match[2], match[3]].map(Number);
  return minutes > 59 || seconds > 59 ? null : hours * 3600 + minutes * 60 + seconds;
}

function clockText(seconds) {
  if (seconds === null) return UNKNOWN_CLOCK;
  const part = (value) => String(value).padStart(2, '0');
  return `${part(Math.floor(seconds / 3600))}:${part(Math.floor(seconds / 60) % 60)}:${part(seconds % 60)}`;
}

// Same line selection, cleaning and dedup as `transcriptText`, with the
// start time of the cue that holds each kept line in front of it. A repeated
// line keeps the first time. A line with no known cue time (none seen yet, or
// a malformed or over-99-hour cue time) is marked with `[--:--:--]`.
export function transcriptTextWithTimestamps(text) {
  let time = null;
  const entries = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const cue = cueStartSeconds(line);
    if (cue !== undefined) { time = cue; continue; }
    if (!isCaptionSpeech(line)) continue;
    const clean = cleanCaptionLine(line);
    if (clean) entries.push({ time, clean });
  }
  return entries.filter((entry, index) => index === 0 || entry.clean !== entries[index - 1].clean)
    .map((entry) => `[${clockText(entry.time)}] ${entry.clean}`).join('\n');
}

export function findTranscript(directory, { timestamps = false } = {}) {
  const files = readdirSync(directory).filter((name) => /\.(vtt|srt)$/.test(name));
  const infoName = readdirSync(directory).find((name) => name.endsWith('.info.json'));
  const language = infoName ? JSON.parse(readFileSync(join(directory, infoName), 'utf8')).language : null;
  const name = files.find((name) => language && name.startsWith('media.' + language + '.')) ??
    files.find((name) => name === 'media.en.vtt' || name === 'media.en.srt') ?? files[0];
  if (!name) throw mediaError('transcript_unavailable', 'No captions available. Try --audio.');
  const mediaPath = join(directory, name);
  const caption = readFileSync(mediaPath, 'utf8');
  const text = timestamps ? transcriptTextWithTimestamps(caption) : transcriptText(caption);
  if (!text) throw mediaError('transcript_unavailable', 'No caption text available. Try --audio.');
  return { mediaPath, text, mimeType: 'text/plain', bytes: statSync(mediaPath).size, mode: 'transcript' };
}

export function cleanupMedia(directory, keep) { if (directory && !keep) rmSync(directory, { recursive: true, force: true }); }

export function toolOnPath(name, env = process.env) {
  const found = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { env, encoding: 'utf8', timeout: 5000 });
  if (found.status !== 0) return null;
  return found.stdout.trim().split(/\r?\n/).find((path) => !/\.(cmd|bat)$/i.test(path)) ?? null;
}

export function mediaDoctor(env = process.env) {
  const path = toolOnPath('yt-dlp', env);
  const version = path ? spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: 15000 }).stdout?.trim() : null;
  const ffmpeg = toolOnPath('ffmpeg', env);
  return { ytDlp: path ? { path, version: version || 'absent' } : { path: 'absent', version: 'absent' },
    ffmpeg: { path: ffmpeg ?? 'absent' }, sizeCapBytes: MEDIA_MAX_BYTES };
}

export function captionMetadataArgs(videoId) {
  return ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json',
    '--', `https://www.youtube.com/watch?v=${videoId}`];
}
