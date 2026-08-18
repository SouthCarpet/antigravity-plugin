/**
 * agent-runtime — single chokepoint for spawning the Antigravity CLI (`agy`).
 *
 * Why a chokepoint?
 *  - Centralizes binary resolution and version probing.
 *  - Lets tests inject a fake binary or mock spawn function.
 *  - Keeps every caller honest about non-streaming output (final response
 *    only) so we never accidentally write code that expects ACP semantics.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join, delimiter } from 'node:path';

/** Default binary name. Override via env `AGY_BIN`. */
export const DEFAULT_AGY_BIN = 'agy';

/** Sentinel lines surfaced by `agy --print` when the user needs to (re-)auth. */
const AUTH_LINE_PATTERNS = [
  /^Authentication required\.?\s*Please visit the URL to log in/i,
  /^Waiting for authentication/i,
];
// Excludes `"` and `\` (not just whitespace) so a URL embedded in a
// stream-json string field — e.g. inside `result.response` — doesn't swallow
// the JSON that follows its closing quote; plain --print text never had
// those chars adjacent to begin with, so this is non-breaking there too.
const AUTH_URL_PATTERN = /(https?:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"\\]+)/;

/** Candidate executable names to try in each PATH/home dir, by platform. */
function candidateNames(platform) {
  return platform === 'win32' ? ['agy.exe', 'agy.cmd', DEFAULT_AGY_BIN] : [DEFAULT_AGY_BIN];
}

/**
 * Resolve the `agy` binary path.
 *
 * Order: `$AGY_BIN` → first `agy` on `PATH` → `~/.local/bin/agy` → bare
 * `agy` (left for the shell / PATH lookup at spawn time).
 *
 * On win32, `PATH`/`Path` is split on `path.delimiter` (`;`, not POSIX `:`)
 * and each directory is probed for `agy.exe`, `agy.cmd`, then bare `agy`
 * (covers native installs, npm shims, and MSYS-style installs). The home
 * fallback checks `HOME` then `USERPROFILE`, since `HOME` is frequently
 * unset in native Windows shells.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform] - defaults to `process.platform`; injectable for tests.
 */
export function resolveAgyBin(env = process.env, platform = process.platform) {
  if (env.AGY_BIN && existsSync(env.AGY_BIN)) return env.AGY_BIN;

  const names = candidateNames(platform);
  const PATH = env.PATH || env.Path || '';
  for (const dir of PATH.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const home = env.HOME || env.USERPROFILE;
  if (home) {
    for (const name of names) {
      const candidate = join(home, '.local', 'bin', name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return DEFAULT_AGY_BIN;
}

/**
 * Probe `agy --version`. Resolves to `{ ok: true, version }` or
 * `{ ok: false, reason }`.
 */
export async function probeAgy({ bin = resolveAgyBin(), timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: e.code === 'ENOENT' ? 'not-installed' : e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, reason: `exit ${code}` });
      resolve({ ok: true, version: stdout.trim().split(/\s+/)[0] || 'unknown' });
    });
  });
}

/**
 * Build the single NDJSON line agy expects on stdin in stream-json mode.
 */
function buildStreamJsonLine(prompt) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
}

/**
 * Stateful NDJSON line splitter for incremental parsing as `data` chunks
 * arrive: feed it a raw chunk via `.push(chunk)`, get back the array of
 * complete JSON-parsed events it completed (a chunk boundary splitting a
 * line is reassembled across calls — the partial tail is buffered until a
 * later push supplies the rest). Parse failures on a completed line are
 * dropped silently (stream noise), never thrown.
 */
function createNdjsonLineFeeder() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // last element: partial unless the chunk ended in '\n'
      const events = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // torn line — stream noise, not a caller-facing error
        }
      }
      return events;
    },
  };
}

/**
 * Parse an agy `--output-format stream-json` NDJSON stdout blob (one or
 * more `\n`-terminated JSON lines — `init`, `step_update`, `result`) and
 * extract the fields carried by its `result` event:
 * `{ conversation_id, status, response, duration_seconds, usage }` (probed
 * live on agy 1.1.14, 2026-08-18).
 *
 * Lines that fail to parse (a chunk boundary split a line; the process was
 * killed mid-write) are skipped, never thrown. If more than one `result`
 * event appears, the last one wins. When no `result` event is found,
 * `sawResult` is `false` and every other field stays `null` — nothing is
 * guessed from `step_update`/`init` events.
 *
 * @param {string} text - full accumulated stdout (or any concatenation of
 *   chunks — reassembly across chunk boundaries falls out of `\n`-splitting
 *   the joined string, so callers never need to pre-align chunks).
 * @returns {{ response: string|null, usage: object|null, durationSeconds: number|null,
 *   conversationId: string|null, resultStatus: string|null, sawResult: boolean }}
 */
export function parseAgyStream(text) {
  const out = {
    response: null,
    usage: null,
    durationSeconds: null,
    conversationId: null,
    resultStatus: null,
    sawResult: false,
  };
  if (typeof text !== 'string' || !text.length) return out;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // torn/partial line — stream noise, not a caller-facing error
    }
    if (event?.event !== 'result' || !event.result) continue;
    const r = event.result;
    out.response = typeof r.response === 'string' ? r.response : out.response;
    out.usage = r.usage ?? out.usage;
    out.durationSeconds = r.duration_seconds ?? out.durationSeconds;
    out.conversationId = r.conversation_id ?? out.conversationId;
    out.resultStatus = r.status ?? out.resultStatus;
    out.sawResult = true;
  }
  return out;
}

/**
 * Run `agy` (or a continuation variant) over its stream-json transport and
 * capture the final response.
 *
 * The prompt travels over stdin, never argv: Windows' `CreateProcess` caps
 * a spawned command line at ~32K chars and fails outright above that
 * (Win32 error 206 / Node `ENAMETOOLONG`), and review/rescue/task briefs
 * routinely exceed it. Every invocation instead runs:
 *   `agy [--continue|--conversation <id>] [--add-dir ...]* [--model <id>]
 *        [...extraArgs] --input-format stream-json --output-format
 *        stream-json --print ""`
 * (`--print ""` is required — bare `--print` errors "flag needs an
 * argument", and a non-empty value would be sent as a second prompt) with
 * exactly one NDJSON line written to stdin, then `stdin.end()`:
 *   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}`
 *
 * `mode`:
 *   - `print` (default) — no continuation flag
 *   - `continue` — prepends `--continue`
 *   - `conversation` — prepends `--conversation <id>`
 *
 * `model`, if given, pushes `--model <id>`. `extraArgs`, if given, is
 * appended (in order) after `--model`. Both land before the always-on
 * `--input-format`/`--output-format`/`--print` tail.
 *
 * `outputFormat` is accepted for backward compat but is now a no-op — agy
 * always runs in stream-json mode, which carries the same envelope fields
 * regardless of what (if anything) this is set to.
 *
 * stdout is agy's NDJSON event stream (`init`, `step_update`, `result`);
 * raw chunks still reach `onStdout` as before (unparsed — callers that want
 * readable text, not JSON, should use `onText` instead; see below). The
 * `result` event (parsed via `parseAgyStream`) drives the return contract:
 * `stdout` becomes `result.response`, and `usage`, `durationSeconds`,
 * `agyConversationId`, `rawStdout` (the full raw NDJSON text) are ALWAYS
 * populated on exit — not gated behind `outputFormat` any more.
 *
 * `onText(delta)`, if given, fires once per `step_update` event whose
 * `step_update.text_delta` is a non-empty string — i.e. the readable model
 * text as it streams in, with the `init`/`step_update` JSON envelope
 * stripped off. Parsed incrementally as chunks arrive (a JSON line split
 * across two `data` chunks is reassembled before being handed to
 * `onText`), independent of `onStdout`'s raw pass-through.
 *
 * Returns `{ status, stdout, stderr, exitCode, oauthUrl, usage,
 * durationSeconds, agyConversationId, rawStdout }`. `status` is one of
 * `completed`, `failed`, `auth_required`, `cancelled`, `timeout`.
 * `exitCode === 0` with no `result` event is `failed`, never a silent
 * success — stderr gains a diagnostic line explaining why. A `result` event
 * whose `status` isn't `SUCCESS` is also `failed`, with that status string
 * folded into stderr. Auth prompts are detected both in the raw stdout text
 * (as before) and in `result.response` — they can arrive either way.
 */
export async function runAgyPrint({
  prompt,
  mode = 'print',
  conversationId,
  cwd = process.cwd(),
  addDirs = [],
  model,
  outputFormat,
  extraArgs = [],
  timeoutMs = 0,
  bin = resolveAgyBin(),
  env = process.env,
  onStdout,
  onStderr,
  onText,
  signal,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.length) {
    throw new TypeError('runAgyPrint: prompt must be a non-empty string');
  }
  const args = [];
  if (mode === 'continue') args.push('--continue');
  if (mode === 'conversation') {
    if (!conversationId) throw new TypeError('runAgyPrint: conversationId required for mode=conversation');
    args.push('--conversation', conversationId);
  }
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (model) args.push('--model', model);
  args.push(...extraArgs);
  args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '');

  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let oauthUrl;
  let status;

  child.stdin.on('error', (e) => {
    // EPIPE if agy exits before we finish writing the prompt line — record
    // it, never let it surface as an unhandled 'error' event.
    stderr += `\nstdin error: ${e.message}`;
  });
  child.stdin.write(buildStreamJsonLine(prompt) + '\n');
  child.stdin.end();

  const lineFeeder = onText ? createNdjsonLineFeeder() : null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!oauthUrl) {
      const m = chunk.match(AUTH_URL_PATTERN);
      if (m) {
        oauthUrl = m[1];
        status ??= 'auth_required';
      } else if (AUTH_LINE_PATTERNS.some((p) => p.test(chunk))) {
        status ??= 'auth_required';
      }
    }
    if (lineFeeder) {
      for (const event of lineFeeder.push(chunk)) {
        const delta = event?.event === 'step_update' ? event.step_update?.text_delta : undefined;
        if (typeof delta === 'string' && delta.length) onText(delta);
      }
    }
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    onStderr?.(chunk);
  });

  const timer = timeoutMs > 0
    ? setTimeout(() => {
        status = 'timeout';
        child.kill('SIGTERM');
      }, timeoutMs)
    : null;

  if (signal) {
    if (signal.aborted) child.kill('SIGTERM');
    else signal.addEventListener('abort', () => {
      status = 'cancelled';
      child.kill('SIGTERM');
    }, { once: true });
  }

  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => {
      stderr += `\nspawn error: ${e.message}`;
      resolve(typeof e.errno === 'number' ? e.errno : 1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });

  if (timer) clearTimeout(timer);

  const parsed = parseAgyStream(stdout);

  // Auth prompts may arrive as raw stdout text (checked per-chunk above) OR
  // folded into the result event's response field — check both.
  if (!status && typeof parsed.response === 'string') {
    const m = parsed.response.match(AUTH_URL_PATTERN);
    if (m) {
      oauthUrl = oauthUrl ?? m[1];
      status = 'auth_required';
    } else if (AUTH_LINE_PATTERNS.some((p) => p.test(parsed.response))) {
      status = 'auth_required';
    }
  }

  if (!status) {
    if (exitCode !== 0) {
      status = 'failed';
    } else if (!parsed.sawResult) {
      status = 'failed';
      stderr += '\nagent-runtime: agy exited 0 without a result event (stream truncated?)';
    } else if (parsed.resultStatus !== 'SUCCESS') {
      status = 'failed';
      stderr += `\nagent-runtime: agy result status was "${parsed.resultStatus ?? 'unknown'}", not SUCCESS`;
    } else {
      status = 'completed';
    }
  }

  return {
    status,
    stderr,
    exitCode,
    oauthUrl,
    stdout: parsed.sawResult && typeof parsed.response === 'string' ? parsed.response : stdout,
    rawStdout: stdout,
    usage: parsed.usage ?? null,
    durationSeconds: parsed.durationSeconds ?? null,
    agyConversationId: parsed.conversationId ?? null,
  };
}

/**
 * Tiny helper for callers that want to fire-and-forget into the background.
 * Returns the child handle without awaiting, so the caller is responsible
 * for capturing exit + stdout in a separate file (see job-control.mjs).
 *
 * Same stream-json transport as `runAgyPrint` (see its doc comment above):
 * the prompt travels as a single NDJSON line on stdin, so `stdin` is always
 * `'pipe'` even though the caller never reads anything back from it.
 */
export function spawnAgyDetached({
  prompt,
  mode = 'print',
  conversationId,
  cwd = process.cwd(),
  addDirs = [],
  model,
  extraArgs = [],
  bin = resolveAgyBin(),
  env = process.env,
  stdout = 'pipe',
  stderr = 'pipe',
} = {}) {
  const args = [];
  if (mode === 'continue') args.push('--continue');
  if (mode === 'conversation') {
    if (!conversationId) throw new TypeError('spawnAgyDetached: conversationId required for mode=conversation');
    args.push('--conversation', conversationId);
  }
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (model) args.push('--model', model);
  args.push(...extraArgs);
  args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '');

  const child = spawn(bin, args, {
    cwd,
    env,
    detached: true,
    stdio: ['pipe', stdout, stderr],
  });

  // Fire-and-forget: nobody awaits this child, so an EPIPE on stdin (agy
  // dying before we finish writing the prompt line) must not throw an
  // unhandled 'error' event.
  child.stdin.on('error', () => {});
  child.stdin.write(buildStreamJsonLine(prompt) + '\n');
  child.stdin.end();

  return child;
}
