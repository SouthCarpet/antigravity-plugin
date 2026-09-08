/**
 * agent-runtime — single chokepoint for spawning the Antigravity CLI (`agy`).
 *
 * Why a chokepoint?
 *  - Centralizes binary resolution and version probing.
 *  - Lets tests inject a fake binary or mock spawn function.
 *  - Keeps every caller honest about non-streaming output (final response
 *    only) so we never accidentally write code that expects ACP semantics.
 */
import { spawn } from './process-adapter.mjs';
import { terminateProcessTree } from './process.mjs';
import { existsSync } from 'node:fs';
import { join, delimiter, extname } from 'node:path';

/** Default binary name. Override via env `AGY_BIN`. */
export const DEFAULT_AGY_BIN = 'agy';

// Bound retained agy transport output: 16 MiB stdout and 4 MiB stderr.
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 4 * 1024 * 1024;
export const STDIO_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Sentinel lines surfaced by `agy --print` when the user needs to (re-)auth.
 * None of these may carry the `/g` flag: {@link recordRawAuthSignal} does
 * `AUTH_LINE_PATTERNS.find(p => p.test(chunk))` followed by
 * `chunk.match(pattern)`, and a global-flagged pattern's stateful
 * `lastIndex` can desynchronize those two calls on the same chunk.
 *
 * Exported as a test-only seam (the `resetWorkspaceRootCache` precedent, see
 * `scripts/lib/workspace.mjs`): only `tests/agent-runtime-stream.test.mjs`
 * imports it, so the `/g`-safety invariant above stays independently
 * checkable without exercising the full stream.
 */
export const AUTH_LINE_PATTERNS = [
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

function isExeName(name) {
  return extname(name).toLowerCase() === '.exe';
}

function firstExisting(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * True when `bin` is a Windows batch shim. Node refuses to spawn these
 * directly (EINVAL on >= 20.12.2) because arguments go through cmd.exe,
 * which is an argument-injection surface (CVE-2024-27980). This plugin
 * puts user prompts in those arguments, so we never make `.cmd`/`.bat`
 * spawnable.
 *
 * @param {string} bin
 * @returns {boolean}
 */
export function isWindowsBatchFile(bin) {
  const ext = extname(String(bin ?? '')).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/**
 * Actionable refusal for a resolved `.cmd`/`.bat` path, including when
 * the user pointed `AGY_BIN` at one.
 *
 * @param {string} bin
 * @returns {string}
 */
export function batchShimRefusalMessage(bin) {
  return (
    `Refusing to spawn "${bin}" because it is a Windows .cmd/.bat shim. ` +
    `Node.js cannot execute batch files directly (EINVAL on Node >= 20.12.2), ` +
    `and passing user prompts through cmd.exe is an argument-injection surface. ` +
    `Point AGY_BIN at the real agy.exe (the native binary, not this shim).`
  );
}

/**
 * Throw if `bin` is a `.cmd`/`.bat` shim. Call this at every spawn site
 * instead of letting a raw EINVAL escape.
 *
 * @param {string} bin
 * @returns {void}
 */
export function assertAgyBinSpawnable(bin) {
  if (isWindowsBatchFile(bin)) {
    throw new Error(batchShimRefusalMessage(bin));
  }
}

function spawnAgy(bin, args, opts) {
  assertAgyBinSpawnable(bin);
  return spawn(bin, args, opts);
}

/** Terminal signals a foreground run has to pass on to a detached child. */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Bridge the terminal's interactive signals to `onSignal` while a detached
 * child is alive; the returned function removes the handlers again.
 *
 * agy is spawned `detached` on POSIX so `terminateProcessTree` can signal the
 * whole group with `kill(-pid)`. `detached` makes the child a session leader,
 * so it no longer belongs to the terminal's foreground process group: without
 * this bridge, Ctrl+C (or SIGHUP on a closing terminal) would kill the plugin
 * and its execution budget while agy kept running unbounded. Callers must
 * remove the handlers when the child settles, otherwise a later Ctrl+C would
 * no longer terminate the process.
 *
 * Only installed on the detached path — on win32 the child stays in the
 * console's process group and Ctrl+C reaches it as before.
 *
 * @param {(signal: string) => void} onSignal
 * @returns {() => void}
 */
function forwardTerminationSignals(onSignal) {
  const installed = FORWARDED_SIGNALS.map((name) => {
    const handler = () => onSignal(name);
    process.on(name, handler);
    return [name, handler];
  });
  return () => {
    for (const [name, handler] of installed) process.off(name, handler);
  };
}

/**
 * Resolve the `agy` binary path.
 *
 * Order: `$AGY_BIN` → `PATH` → `~/.local/bin/agy` → bare `agy` (left for
 * the shell / PATH lookup at spawn time).
 *
 * On win32, `PATH`/`Path` is split on `path.delimiter` (`;`, not POSIX `:`)
 * and searched in two passes: every directory for `agy.exe` first, and only
 * then every directory for `agy.cmd` / bare `agy`. An `.exe` later on PATH
 * therefore wins over a `.cmd` shim in an earlier directory. The home
 * fallback checks `HOME` then `USERPROFILE`, since `HOME` is frequently
 * unset in native Windows shells.
 *
 * Resolving to a `.cmd`/`.bat` is not the same as spawning it: spawn sites
 * refuse batch shims via `assertAgyBinSpawnable`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform] - defaults to `process.platform`; injectable for tests.
 * @returns {string} an absolute path when found, else the bare `agy` name
 */
export function resolveAgyBin(env = process.env, platform = process.platform) {
  if (env.AGY_BIN && existsSync(env.AGY_BIN)) return env.AGY_BIN;

  const names = candidateNames(platform);
  const exeNames = names.filter(isExeName);
  const restNames = names.filter((name) => !isExeName(name));
  const PATH = env.PATH || env.Path || '';
  const pathDirs = PATH.split(delimiter).filter(Boolean);

  const fromPathExe = firstExisting(pathDirs, exeNames);
  if (fromPathExe) return fromPathExe;
  const fromPathRest = firstExisting(pathDirs, restNames);
  if (fromPathRest) return fromPathRest;

  const home = env.HOME || env.USERPROFILE;
  if (home) {
    const homeDirs = [join(home, '.local', 'bin')];
    const fromHomeExe = firstExisting(homeDirs, exeNames);
    if (fromHomeExe) return fromHomeExe;
    const fromHomeRest = firstExisting(homeDirs, restNames);
    if (fromHomeRest) return fromHomeRest;
  }

  return DEFAULT_AGY_BIN;
}

/**
 * Probe `agy --version`. Resolves to `{ ok: true, version }` or
 * `{ ok: false, reason }`.
 *
 * @param {{ bin?: string, timeoutMs?: number,
 *   terminateTree?: typeof terminateProcessTree, platform?: string }} [options]
 * @returns {Promise<{ ok: true, version: string } | { ok: false, reason: string }>}
 */
export async function probeAgy({
  bin = resolveAgyBin(),
  timeoutMs = 5000,
  terminateTree = terminateProcessTree,
  platform = process.platform,
} = {}) {
  try {
    assertAgyBinSpawnable(bin);
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
  const detached = platform !== 'win32';
  let timer;
  let termination;
  let removeSignalHandlers = null;
  try {
    return await new Promise((resolve) => {
      const child = spawnAgy(bin, ['--version'], {
        detached, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      const abandon = (reason) => {
        termination = terminateTree(child.pid).catch(() => {});
        child.stdout.destroy?.();
        child.stderr.destroy?.();
        child.unref?.();
        resolve({ ok: false, reason });
      };
      // The existing total probe deadline also bounds pipes inherited after exit.
      timer = setTimeout(() => abandon('timeout'), timeoutMs);
      // A detached probe leaves the terminal's process group, so Ctrl+C has to
      // be passed on explicitly (see forwardTerminationSignals).
      if (detached) removeSignalHandlers = forwardTerminationSignals(() => abandon('cancelled'));
      child.stdout.on('data', (c) => {
        // A version needs only its first token; drain the rest without retaining it.
        if (stdout.length < 4096) stdout += c.toString('utf8').slice(0, 4096 - stdout.length);
      });
      child.stderr.resume?.();
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: e.code === 'ENOENT' ? 'not-installed' : e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ ok: false, reason: `exit ${code}` });
        resolve({ ok: true, version: stdout.trim().split(/\s+/)[0] || 'unknown' });
      });
    });
  } finally {
    clearTimeout(timer);
    removeSignalHandlers?.();
    await termination;
  }
}

/**
 * Build the single NDJSON line agy expects on stdin in stream-json mode.
 *
 * agy 1.1.15 requires an `{"event":"user", ...}` envelope; the earlier
 * `{"type":"user", ...}` shape (accepted by 1.1.14) is now rejected with
 * 'stream input message is missing the "event" field'. Probed live
 * 2026-08-19: type-shape ERROR, event-shape SUCCESS. The inner content
 * part keeps `type: 'text'` — only the top-level discriminator changed.
 */
function buildStreamJsonLine(prompt) {
  return JSON.stringify({
    event: 'user',
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
 * `resultError` carries `result.error`, the one-line reason agy attaches to a
 * failed result (`"timeout waiting for response"` on `--print-timeout`,
 * measured on 1.1.24). Without it the caller only learns the status word and
 * has to guess what went wrong.
 *
 * `deniedActions` carries `result.denied_actions` normalized via
 * {@link normalizeDeniedActions} — `null` when the field was absent on every
 * `result` event seen, an array (possibly empty) once one carried it.
 *
 * @param {string} text - full accumulated stdout (or any concatenation of
 *   chunks — reassembly across chunk boundaries falls out of `\n`-splitting
 *   the joined string, so callers never need to pre-align chunks).
 * @returns {{ response: string|null, usage: object|null, durationSeconds: number|null,
 *   conversationId: string|null, resultStatus: string|null, resultError: string|null,
 *   deniedActions: { action: string, displayName: string | null, source: 'json' }[] | null,
 *   sawResult: boolean }}
 */
export function parseAgyStream(text) {
  const out = {
    response: null,
    usage: null,
    durationSeconds: null,
    conversationId: null,
    resultStatus: null,
    resultError: null,
    deniedActions: null,
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
    out.resultError = typeof r.error === 'string' && r.error ? r.error : out.resultError;
    out.deniedActions = Array.isArray(r.denied_actions)
      ? normalizeDeniedActions(r.denied_actions)
      : out.deniedActions;
    out.sawResult = true;
  }
  return out;
}

/**
 * The stderr line for `result.error`, or `''` when agy sent none.
 *
 * agy reports a `--print-timeout` as `status: ERROR` plus
 * `error: "timeout waiting for response"`, and on that path it also exits
 * non-zero with an empty stderr. Repeating the status word alone told the
 * caller nothing, so the reason is echoed on both failure shapes.
 *
 * @param {string|null} resultError
 */
function agyResultErrorNote(resultError) {
  return resultError ? `\nagent-runtime: agy reported error: ${resultError}` : '';
}

/** Bound on the number of `denied_actions` members carried through per run
 * (agy 1.1.27's shape beyond the single-member fixture is UNVERIFIED; a
 * runaway list must never grow the job record without limit). */
export const MAX_DENIED_ACTIONS = 32;

/** Bound on each `action`/`display_name` string's length after sanitizing. */
export const MAX_DENIED_ACTION_STRING_LENGTH = 200;

/**
 * Strip C0 control characters and DEL, trim, and cap the length of one
 * `denied_actions` string field. Returns `null` for anything that is not a
 * non-empty string once sanitized, so a caller can treat that as "missing".
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function sanitizeDeniedActionString(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!stripped) return null;
  return stripped.length > MAX_DENIED_ACTION_STRING_LENGTH
    ? stripped.slice(0, MAX_DENIED_ACTION_STRING_LENGTH)
    : stripped;
}

/**
 * Validate and normalize one raw `result.denied_actions` member into
 * `{ action, displayName, source: "json" }`. A member with no usable
 * `action` string is malformed and is skipped (returns `null`).
 *
 * @param {unknown} member
 * @returns {{ action: string, displayName: string | null, source: 'json' } | null}
 */
function normalizeJsonDeniedAction(member) {
  if (!member || typeof member !== 'object') return null;
  const action = sanitizeDeniedActionString(member.action);
  if (!action) return null;
  return { action, displayName: sanitizeDeniedActionString(member.display_name), source: 'json' };
}

/**
 * Normalize agy's `result.denied_actions` array (T0a: 0..n members, repeats,
 * and the field on a non-SUCCESS result are all UNVERIFIED beyond the single-
 * member SUCCESS fixture) into a bounded, de-duplicated list: malformed
 * members are skipped, exact repeats (same action + displayName) are
 * dropped, and the result is capped at {@link MAX_DENIED_ACTIONS}.
 *
 * @param {unknown} rawList
 * @returns {{ action: string, displayName: string | null, source: 'json' }[]}
 */
export function normalizeDeniedActions(rawList) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out = [];
  for (const member of rawList) {
    const normalized = normalizeJsonDeniedAction(member);
    if (!normalized) continue;
    const key = `${normalized.action} ${normalized.displayName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= MAX_DENIED_ACTIONS) break;
  }
  return out;
}

/**
 * Merge the structured JSON `denied_actions` list with the stderr
 * auto-denial sentinel ({@link detectAutoDenial}) into the one list every
 * output path renders: the JSON list wins when agy reported one at all; the
 * sentinel becomes a single `source: "stderr"` member only when no JSON list
 * was present, so older agy (no `denied_actions` field) still surfaces its
 * one known denial, never duplicated once agy 1.1.27's own list also carries
 * it. `null` when neither source has anything (the additive "no
 * information" contract T2 item 2 requires).
 *
 * @param {{ action: string, displayName: string | null }[] | null} jsonList
 * @param {{ tool: string, line: string } | null} sentinelDenial
 * @returns {{ action: string, displayName: string | null, source: 'json' | 'stderr' }[] | null}
 */
export function mergeDeniedActions(jsonList, sentinelDenial) {
  if (jsonList && jsonList.length) return jsonList;
  if (sentinelDenial) return [{ action: sentinelDenial.tool, displayName: null, source: 'stderr' }];
  return null;
}

/**
 * Find a headless permission auto-denial in agy's stderr.
 *
 * Since agy 1.1.20 a tool that print mode cannot prompt for is auto-denied
 * while the run still exits 0 with `status: SUCCESS`; the only trace is a
 * stderr line such as (1.1.24, verbatim):
 *   jetski: no output produced — a tool required the "read_file" permission
 *   that headless mode cannot prompt for, so it was auto-denied. ...
 * Only `auto-denied` and the first quoted token on that line are treated as
 * stable; agy rewords the surrounding hints between releases.
 *
 * @param {string} stderr
 * @returns {{ tool: string, line: string } | null}
 */
export function detectAutoDenial(stderr) {
  if (typeof stderr !== 'string' || !stderr.length) return null;
  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes('auto-denied')) continue;
    const quoted = line.match(/"([^"]+)"/);
    return { tool: quoted ? quoted[1] : 'unknown', line };
  }
  return null;
}

/**
 * `options[key]` when present, else the lazily-computed fallback — the same
 * "only `undefined` triggers the default" rule a default-parameter value
 * follows, kept as a plain function so `runAgyPrint`'s many optional fields
 * don't each add a branch to its own complexity (they used to be default
 * parameter values on the destructured signature itself).
 *
 * @param {object} options
 * @param {string} key
 * @param {() => any} getFallback called only when `options[key] === undefined`
 * @returns {any}
 */
function optionOrDefault(options, key, getFallback) {
  return options[key] === undefined ? getFallback() : options[key];
}

/**
 * Apply `runAgyPrint`'s default values to a raw options object. `outputFormat`
 * is accepted for backward compat but is a no-op (see the `runAgyPrint`
 * doc comment) and is not read here.
 *
 * @param {import('./types.mjs').ProcessRequest & { platform?: NodeJS.Platform }} options
 * @returns {object} every `runAgyPrint` field, fully defaulted
 */
function normalizeRunOptions(options) {
  return {
    prompt: options.prompt,
    mode: optionOrDefault(options, 'mode', () => 'print'),
    conversationId: options.conversationId,
    cwd: optionOrDefault(options, 'cwd', () => process.cwd()),
    addDirs: optionOrDefault(options, 'addDirs', () => []),
    model: options.model,
    extraArgs: optionOrDefault(options, 'extraArgs', () => []),
    timeoutMs: optionOrDefault(options, 'timeoutMs', () => 0),
    bin: optionOrDefault(options, 'bin', () => resolveAgyBin()),
    env: optionOrDefault(options, 'env', () => process.env),
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    onText: options.onText,
    onSpawn: options.onSpawn,
    signal: options.signal,
    terminationGraceMs: optionOrDefault(options, 'terminationGraceMs', () => 500),
    forceKillGraceMs: optionOrDefault(options, 'forceKillGraceMs', () => 500),
    maxStdoutBytes: optionOrDefault(options, 'maxStdoutBytes', () => MAX_STDOUT_BYTES),
    maxStderrBytes: optionOrDefault(options, 'maxStderrBytes', () => MAX_STDERR_BYTES),
    stdioDrainTimeoutMs: optionOrDefault(options, 'stdioDrainTimeoutMs', () => STDIO_DRAIN_TIMEOUT_MS),
    terminateTree: optionOrDefault(options, 'terminateTree', () => terminateProcessTree),
    platform: optionOrDefault(options, 'platform', () => process.platform),
  };
}

/** Forwarded for `timeoutMs === 0` ("no deadline"): agy treats a literal
 * `--print-timeout 0` as an immediate timeout, not as disabled (T0a fixtures
 * item 4), so a large fixed duration stands in as the practical ceiling of a
 * "no deadline" run. */
export const PRINT_TIMEOUT_NO_DEADLINE = '24h';

/** Headroom added on top of the plugin's own outer budget before it is
 * forwarded to agy as `--print-timeout`, so the plugin's deadline
 * (`runAgyPrint`'s `session.timer`) fires first and agy's timeout stays a
 * backstop. */
const PRINT_TIMEOUT_HEADROOM_MS = 60_000;

/**
 * Render the resolved outer execution budget as agy's `--print-timeout`
 * value: a Go duration string. A finite budget (`timeoutMs > 0`) becomes
 * `<budget + 60s headroom>` rounded up to whole seconds (`1860s` for the
 * 30-minute default; never fractional). Anything else — `0` ("no
 * deadline"), a negative value, or a non-finite value — becomes
 * {@link PRINT_TIMEOUT_NO_DEADLINE}; `--print-timeout` must never be `0` or
 * a fractional/negative value.
 *
 * @param {number} timeoutMs
 * @returns {string}
 */
export function printTimeoutArg(timeoutMs) {
  if (!(timeoutMs > 0)) return PRINT_TIMEOUT_NO_DEADLINE;
  const seconds = Math.ceil((timeoutMs + PRINT_TIMEOUT_HEADROOM_MS) / 1000);
  return `${seconds}s`;
}

/**
 * Build the agy argv for one `runAgyPrint` invocation: the continuation
 * flag (if any), `--add-dir`/`--model`/extra args, `--print-timeout`
 * ({@link printTimeoutArg}) and `--disable-slash-commands`, then the
 * always-on stream-json/print tail. The two new flags apply to every
 * print-mode path (plain print, `--continue`, `--conversation`) the same
 * way; the `--version` probe does not go through this builder.
 *
 * @param {{ mode: string, conversationId?: string, addDirs: string[],
 *   model?: string, extraArgs: string[], timeoutMs: number }} options
 * @returns {string[]}
 */
function buildAgyArgs({ mode, conversationId, addDirs, model, extraArgs, timeoutMs }) {
  const args = [];
  if (mode === 'continue') args.push('--continue');
  if (mode === 'conversation') {
    if (!conversationId) throw new TypeError('runAgyPrint: conversationId required for mode=conversation');
    args.push('--conversation', conversationId);
  }
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (model) args.push('--model', model);
  args.push(...extraArgs);
  args.push('--print-timeout', printTimeoutArg(timeoutMs));
  args.push('--disable-slash-commands');
  args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--print', '');
  return args;
}

/**
 * Scan one raw stdout chunk for a raw (non-JSON) auth signal — the OAuth
 * URL itself, or one of agy's short sentinel lines — and record it on
 * `session`. Only the first signal wins (`session.oauthUrl` gates it); the
 * exact matched text (never the whole chunk) is kept in
 * `session.rawAuthEvidence` so the SUCCESS-response reclassification below
 * can tell a genuine raw signal apart from a raw match that only fired
 * because the same bytes are also inside the JSON `result.response` field.
 *
 * Guards the sentinel match's `[0]` index: `AUTH_LINE_PATTERNS.find` already
 * proved one pattern matches via `.test()`, but a global-flagged pattern's
 * stateful `lastIndex` can desynchronize `.test()` from a later `.match()`
 * on the same chunk, so `.match()` returning `null` here is treated as "no
 * evidence this chunk", not indexed into.
 *
 * @param {{ oauthUrl?: string, status?: string, rawAuthEvidence: string | null }} session
 * @param {string} chunk
 * @returns {void}
 */
function recordRawAuthSignal(session, chunk) {
  if (session.oauthUrl) return;
  const m = chunk.match(AUTH_URL_PATTERN);
  if (m) {
    session.oauthUrl = m[1];
    session.status ??= 'auth_required';
    session.rawAuthEvidence ??= m[1];
    return;
  }
  const sentinelPattern = AUTH_LINE_PATTERNS.find((p) => p.test(chunk));
  if (!sentinelPattern) return;
  session.status ??= 'auth_required';
  if (session.rawAuthEvidence !== null) return;
  const match = chunk.match(sentinelPattern);
  if (match) session.rawAuthEvidence = match[0].trim();
}

/**
 * Clear and null every timer handle on `session`, skipping a handle that is
 * already `null`. Real Node's `clearTimeout(null)` is a silent no-op, but
 * Node 22.3's `node:test` mock timers throw `TypeError: Cannot read
 * properties of null (reading 'priorityQueuePosition')` on that exact call
 * (probed directly: `clearTimeout(null)` throws under mock timers,
 * `clearTimeout` on an already-fired-but-still-referenced handle does not).
 * `timer`/`drainTimer`/`giveUpTimer` are frequently still `null` here — most
 * runs never hit the execution timeout or the give-up deadline — so the
 * guard is required on every call, not just a defensive extra. Each handle
 * is also nulled inside its own firing callback (drain, give-up, execution
 * timeout) so a settled session never re-reads a stale handle.
 *
 * @param {{ timer: NodeJS.Timeout | null, drainTimer: NodeJS.Timeout | null,
 *   giveUpTimer: NodeJS.Timeout | null }} session
 * @returns {void}
 */
function clearSessionTimers(session) {
  if (session.timer) clearTimeout(session.timer);
  if (session.drainTimer) clearTimeout(session.drainTimer);
  if (session.giveUpTimer) clearTimeout(session.giveUpTimer);
  session.timer = null;
  session.drainTimer = null;
  session.giveUpTimer = null;
}

/**
 * Create the mutable per-run state `runAgyPrint` threads through spawn,
 * stream wiring, and termination handling, plus the `exitCodePromise` that
 * settles once the child's lifecycle events resolve it exactly once.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ stdioDrainTimeoutMs: number, terminateTree: typeof terminateProcessTree,
 *   terminationGraceMs: number, forceKillGraceMs: number }} config
 * @returns {object} the run session (see call sites for the fields it carries)
 */
function createRunSession(child, { stdioDrainTimeoutMs, terminateTree, terminationGraceMs, forceKillGraceMs }) {
  const session = {
    stdout: '',
    stderr: '',
    oauthUrl: undefined,
    status: undefined,
    rawAuthEvidence: null,
    spawnError: null,
    timer: null,
    drainTimer: null,
    giveUpTimer: null,
    terminationTask: undefined,
    terminationReason: null,
    errorMessage: null,
    settleExit: undefined,
    settled: false,
    exited: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    warnings: [],
  };

  // Destroying is not enough to let this process exit: the pending shutdown
  // of the stdin pipe (from `stdin.end()`) stays an active handle while a
  // grandchild that inherited the descriptors keeps it open, so the handles
  // are also unreferenced. Without the unref, a library caller settles at the
  // drain deadline but only exits when that grandchild does.
  session.destroyStdio = () => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.destroy?.();
      stream?.unref?.();
    }
  };

  session.exitCodePromise = new Promise((resolve) => {
    session.settleExit = (code) => {
      if (session.settled) return;
      session.settled = true;
      clearSessionTimers(session);
      resolve(code);
    };
    child.on('error', (e) => {
      if (session.settled) return;
      session.spawnError = e.message;
      session.stderr += `\nspawn error: ${e.message}`;
      session.settleExit(typeof e.errno === 'number' ? e.errno : 1);
    });
    child.on('close', (code, signal) => session.settleExit(code ?? (signal ? 1 : 0)));
    child.on('exit', (code, signal) => {
      session.exited = true;
      if (session.settled) return;
      session.drainTimer = setTimeout(() => {
        session.drainTimer = null;
        session.warnings.push(`agy stdio did not close within ${stdioDrainTimeoutMs} ms after exit`);
        session.destroyStdio();
        session.settleExit(code ?? (signal ? 1 : 0));
      }, stdioDrainTimeoutMs);
    });
  });

  session.initiateTermination = (reason, message = null) => {
    if (session.settled || session.terminationReason) return;
    session.terminationReason = reason;
    session.status = reason === 'output_limit' ? 'failed' : reason;
    session.errorMessage = message;
    session.terminationTask = terminateTree(child.pid, {
      graceMs: terminationGraceMs,
      forceGraceMs: forceKillGraceMs,
    }).catch((err) => {
      session.stderr += `\nprocess tree termination failed: ${err.message}`;
    }).then(() => {
      if (!session.settled && !session.exited) {
        // A disappeared PID can precede Node's exit/close events. Give those
        // events a bounded turn to arrive before abandoning the handle.
        session.giveUpTimer = setTimeout(() => {
          session.giveUpTimer = null;
          if (session.settled || session.exited) return; // exit owns the separate drain deadline
          session.stderr += '\nagent-runtime: child did not exit after SIGKILL escalation';
          session.destroyStdio();
          child.unref?.();
          session.settleExit(124);
        }, forceKillGraceMs);
      }
    });
  };

  return session;
}

/**
 * Wire the spawned child's stdin error handler and stdout/stderr `data`
 * listeners: byte-cap enforcement, raw auth-signal scanning
 * ({@link recordRawAuthSignal}), incremental NDJSON `onText` delivery, and
 * the raw `onStdout`/`onStderr` pass-through.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {object} session from {@link createRunSession}
 * @param {{ maxStdoutBytes: number, maxStderrBytes: number,
 *   onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void,
 *   onText?: (delta: string) => void }} config
 * @returns {void}
 */
function wireAgyStreams(child, session, { maxStdoutBytes, maxStderrBytes, onStdout, onStderr, onText }) {
  child.stdin.on('error', (e) => {
    // EPIPE if agy exits before we finish writing the prompt line — record
    // it, never let it surface as an unhandled 'error' event. Newline-
    // terminated: the child's own stderr usually arrives after this.
    session.stderr += `\nstdin error: ${e.message}\n`;
  });
  const lineFeeder = onText ? createNdjsonLineFeeder() : null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (session.settled || session.terminationReason === 'output_limit') return;
    session.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (session.stdoutBytes > maxStdoutBytes) {
      session.initiateTermination('output_limit', `agy output exceeded ${maxStdoutBytes} bytes`);
      return;
    }
    session.stdout += chunk;
    recordRawAuthSignal(session, chunk);
    if (lineFeeder) {
      for (const event of lineFeeder.push(chunk)) {
        const delta = event?.event === 'step_update' ? event.step_update?.text_delta : undefined;
        if (typeof delta === 'string' && delta.length) onText(delta);
      }
    }
    onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (session.settled || session.terminationReason === 'output_limit') return;
    session.stderrBytes += Buffer.byteLength(chunk, 'utf8');
    if (session.stderrBytes > maxStderrBytes) {
      session.initiateTermination('output_limit', `agy output exceeded ${maxStderrBytes} bytes`);
      return;
    }
    session.stderr += chunk;
    onStderr?.(chunk);
  });
}

/**
 * Await `onSpawn`, then write the prompt line and wait for the child to
 * exit. Preserves the original failure contract: if `onSpawn` throws, this
 * drives termination, waits for the child to settle, and rethrows — the
 * caller's promise rejects rather than resolving to a result.
 *
 * @param {{ child: import('node:child_process').ChildProcess, session: object,
 *   prompt: string, onSpawn?: (info: { pid: number | null, child: object }) => void | Promise<void> }} args
 * @returns {Promise<number>}
 */
async function writePromptAndAwaitExit({ child, session, prompt, onSpawn }) {
  try {
    await onSpawn?.({ pid: child.pid ?? null, child });
  } catch (err) {
    session.initiateTermination('failed');
    await session.exitCodePromise;
    throw err;
  }
  if (!session.settled && !session.terminationReason) {
    child.stdin.write(buildStreamJsonLine(prompt) + '\n');
    child.stdin.end();
  }
  return session.exitCodePromise;
}

/**
 * Whether the parsed result is trustworthy as an auth signal at all (item
 * 14): never for a legitimate long SUCCESS answer that merely contains the
 * URL text, only when it looks like agy's own short sentinel line (under
 * 512 chars, first line matching `AUTH_LINE_PATTERNS`) or the run did not
 * succeed — agy's own failure text has no length promise.
 *
 * @param {ReturnType<typeof parseAgyStream>} parsed
 * @returns {{ responseText: string, looksLikeAuthSentinel: boolean, eligible: boolean }}
 */
// The live auth output shape on agy 1.1.24 was not re-probed for this change.
// Classification is pinned by the sentinel, URL, and split-chunk cases in tests/agent-runtime-stream.test.mjs.
function computeAuthEligibility(parsed) {
  const responseText = typeof parsed.response === 'string' ? parsed.response : '';
  const responseFirstLine = responseText.split('\n', 1)[0];
  const looksLikeAuthSentinel = AUTH_LINE_PATTERNS.some((p) => p.test(responseFirstLine));
  const eligible = parsed.resultStatus !== 'SUCCESS' ||
    (responseText.length < 512 && looksLikeAuthSentinel);
  return { responseText, looksLikeAuthSentinel, eligible };
}

/**
 * Undo a speculative raw-stdout `auth_required` call once the full result is
 * parsed and it turns out not to be `eligible` (see
 * {@link computeAuthEligibility}) — but ONLY when the raw evidence that
 * triggered it is itself inside the parsed response text: that is what marks
 * it as the same speculative JSON-embedded match
 * ({@link recordRawAuthSignal}'s per-chunk scan runs before parsing can know
 * whether the text will turn out to be a SUCCESS result's response field),
 * not a genuine raw auth prompt/sentinel printed outside the response field
 * (F3 — a real raw signal followed by an unrelated SUCCESS result must stay
 * `auth_required`).
 *
 * Known limit (not a regression): this substring check cannot tell a
 * speculative JSON-embedded match apart from a genuine raw auth prompt whose
 * own URL, or whose sentinel line, happens to also appear verbatim inside an
 * unrelated long SUCCESS answer (A9 for the URL, B11 for the sentinel); it
 * needs a SUCCESS result with a 512+ character answer in the same run as an
 * unauthenticated prompt, which the auth path does not produce.
 *
 * @param {{ status?: string, oauthUrl?: string, rawAuthEvidence: string | null,
 *   parsed: ReturnType<typeof parseAgyStream>, eligible: boolean, responseText: string }} args
 * @returns {{ status?: string, oauthUrl?: string }}
 */
function undoSpeculativeAuthMatch({ status, oauthUrl, rawAuthEvidence, parsed, eligible, responseText }) {
  const rawEvidenceIsSpeculative = rawAuthEvidence !== null && responseText.includes(rawAuthEvidence);
  if (status === 'auth_required' && parsed.sawResult && !eligible && rawEvidenceIsSpeculative) {
    return { status: undefined, oauthUrl: undefined };
  }
  return { status, oauthUrl };
}

/**
 * Auth prompts may also arrive folded into the result event's response
 * field without ever matching at the raw-chunk level (e.g. reassembled only
 * after a chunk boundary split the URL) — check for that here.
 *
 * @param {{ status?: string, oauthUrl?: string, eligible: boolean,
 *   responseText: string, looksLikeAuthSentinel: boolean }} args
 * @returns {{ status?: string, oauthUrl?: string }}
 */
function detectResponseAuthSignal({ status, oauthUrl, eligible, responseText, looksLikeAuthSentinel }) {
  if (status || !eligible) return { status, oauthUrl };
  const m = responseText.match(AUTH_URL_PATTERN);
  if (!m && !looksLikeAuthSentinel) return { status, oauthUrl };
  return { status: 'auth_required', oauthUrl: oauthUrl ?? m?.[1] };
}

/**
 * The final status classification once auth is ruled out: exit code, a
 * missing/non-SUCCESS result event, and headless auto-denials (see
 * `detectAutoDenial`), in the order documented on `runAgyPrint`. A no-op
 * (returns `status` unchanged) once a status is already set.
 *
 * `deniedActions` ({@link mergeDeniedActions} of `parsed.deniedActions` and
 * the stderr sentinel) is computed and returned on every branch, including
 * the ones that never reach the sentinel-driven `denial` check below: the
 * fail-vs-warn decision (`denial`/`nextStatus`) stays keyed on the stderr
 * sentinel exactly as before (T2 item 1's "keep the existing fail-vs-warn
 * decision"); `deniedActions` only adds detail.
 *
 * @param {{ status?: string, exitCode: number, parsed: ReturnType<typeof parseAgyStream>,
 *   stderr: string, warnings: string[] }} args
 * @returns {{ status: string, stderr: string, denial: { tool: string, line: string } | null,
 *   deniedActions: { action: string, displayName: string | null, source: 'json' | 'stderr' }[] | null }}
 */
function classifyFinalStatus({ status, exitCode, parsed, stderr, warnings }) {
  const sentinel = detectAutoDenial(stderr);
  const deniedActions = mergeDeniedActions(parsed.deniedActions, sentinel);
  if (status) return { status, stderr, denial: null, deniedActions };
  let denial = null;
  let nextStatus;
  let nextStderr = stderr;
  if (exitCode !== 0) {
    nextStatus = 'failed';
  } else if (!parsed.sawResult) {
    nextStatus = 'failed';
    nextStderr += '\nagent-runtime: agy exited 0 without a result event (stream truncated?)';
  } else if (parsed.resultStatus !== 'SUCCESS') {
    nextStatus = 'failed';
    nextStderr += `\nagent-runtime: agy result status was "${parsed.resultStatus ?? 'unknown'}", not SUCCESS`;
  } else {
    denial = sentinel;
    const answered = typeof parsed.response === 'string' && parsed.response.trim().length > 0;
    if (denial && !answered) {
      nextStatus = 'failed';
      nextStderr +=
        `\nagent-runtime: agy produced no output because the "${denial.tool}" tool was ` +
        `auto-denied (headless mode cannot prompt for it)`;
    } else {
      nextStatus = 'completed';
      if (denial) warnings.push(denial.line);
    }
  }
  nextStderr += agyResultErrorNote(parsed.resultError);
  return { status: nextStatus, stderr: nextStderr, denial, deniedActions };
}

/**
 * Result classification: parse the accumulated stdout, resolve the final
 * auth status ({@link undoSpeculativeAuthMatch}, {@link detectResponseAuthSignal}),
 * classify the terminal status ({@link classifyFinalStatus}), and assemble
 * the `RuntimeResult` `runAgyPrint` returns.
 *
 * @param {{ session: object, exitCode: number }} args
 * @returns {import('./types.mjs').RuntimeResult}
 */
function classifyRunResult({ session, exitCode }) {
  const parsed = parseAgyStream(session.stdout);
  const authContext = computeAuthEligibility(parsed);

  const undone = undoSpeculativeAuthMatch({
    status: session.status,
    oauthUrl: session.oauthUrl,
    rawAuthEvidence: session.rawAuthEvidence,
    parsed,
    eligible: authContext.eligible,
    responseText: authContext.responseText,
  });
  const detected = detectResponseAuthSignal({
    status: undone.status,
    oauthUrl: undone.oauthUrl,
    eligible: authContext.eligible,
    responseText: authContext.responseText,
    looksLikeAuthSentinel: authContext.looksLikeAuthSentinel,
  });

  const finalized = classifyFinalStatus({
    status: detected.status,
    exitCode,
    parsed,
    stderr: session.stderr,
    warnings: session.warnings,
  });

  return {
    status: finalized.status,
    stderr: session.errorMessage ? `${finalized.stderr}\n${session.errorMessage}` : finalized.stderr,
    errorMessage: session.errorMessage,
    exitCode,
    oauthUrl: detected.oauthUrl,
    stdout: session.terminationReason === 'output_limit' ? session.stdout
      : parsed.sawResult && typeof parsed.response === 'string' ? parsed.response : session.stdout,
    rawStdout: session.stdout,
    usage: parsed.usage ?? null,
    durationSeconds: parsed.durationSeconds ?? null,
    agyConversationId: parsed.conversationId ?? null,
    warnings: session.warnings,
    denial: finalized.denial,
    deniedActions: finalized.deniedActions,
    spawnError: session.spawnError,
  };
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
 *        [...extraArgs] --print-timeout <duration> --disable-slash-commands
 *        --input-format stream-json --output-format stream-json --print ""`
 * (`--print ""` is required — bare `--print` errors "flag needs an
 * argument", and a non-empty value would be sent as a second prompt) with
 * exactly one NDJSON line written to stdin, then `stdin.end()`:
 *   `{"event":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}`
 *
 * `--print-timeout <duration>` ({@link printTimeoutArg}) is agy's own
 * timeout on top of `timeoutMs`'s outer deadline: without it, agy's default
 * `--print-timeout 5m0s` ends any run over five minutes with `status:
 * ERROR`/`"timeout waiting for response"` while this plugin's own (usually
 * longer) budget is still open. The forwarded duration is `timeoutMs + 60s`
 * so this plugin's deadline fires first; `timeoutMs === 0` ("no deadline")
 * forwards {@link PRINT_TIMEOUT_NO_DEADLINE} instead of `0s`, because agy
 * treats a literal `0` as an immediate timeout, not as disabled.
 *
 * `--disable-slash-commands` is always forwarded too: without it, prompt
 * text starting with `/` (untrusted diff/review/rescue/task content) is
 * parsed and executed as an agy slash command instead of being sent as
 * plain prompt text. This is a print-mode parsing switch, not a sandbox —
 * it only stops slash/skill expansion, not what a tool agy itself decides
 * to run.
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
 * Outside win32 the child is spawned `detached` (its own process group, so
 * `terminateProcessTree` can signal the group) and `SIGINT`/`SIGTERM`/`SIGHUP`
 * are forwarded to the same cancellation for as long as the child runs, so
 * Ctrl+C still takes agy and its children down. `platform` overrides the
 * detection for tests.
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
 * durationSeconds, agyConversationId, rawStdout, warnings, denial,
 * deniedActions, spawnError }`. `spawnError` is the child's `error` event message (for
 * example `spawn agy ENOENT`) when the process never started, else `null`.
 * `status` is one of `completed`, `failed`, `auth_required`, `cancelled`,
 * `timeout`. `exitCode === 0` with no `result` event is `failed`, never a
 * silent success — stderr gains a diagnostic line explaining why. A `result`
 * event whose `status` isn't `SUCCESS` is also `failed`, with that status
 * string folded into stderr. A `result.error` reason is folded in as its own
 * `agent-runtime: agy reported error:` line, on the non-zero-exit path too:
 * a `--print-timeout` exits 1 with empty stderr, so the result event is the
 * only place the word "timeout" appears. Auth prompts are detected both in the raw
 * stdout text (as before) and in `result.response` — they can arrive either
 * way.
 *
 * Headless auto-denials (agy >= 1.1.20, see `detectAutoDenial`) are
 * classified after those checks, in this order:
 *   (a) SUCCESS + empty/whitespace `response` + denial on stderr → `failed`;
 *       `denial` is set and stderr gains an `agent-runtime:` line naming the
 *       tool. Callers that know the verb add the per-verb hint.
 *   (b) SUCCESS + non-empty `response` + denial on stderr → `completed`;
 *       the denial line stays in stderr AND is listed in `warnings`. agy
 *       calls these denials benign, so a real answer with one missing input
 *       is not a failure, but it is never swallowed either.
 * A SUCCESS with an empty response and NO denial line stays `completed`: a
 * model may legitimately say nothing.
 *
 * `deniedActions` (additive, T2/plan 085) is the structured detail behind
 * `denial`: agy 1.1.27's `result.denied_actions` JSON list
 * ({@link normalizeDeniedActions}) merged with the stderr sentinel
 * ({@link mergeDeniedActions}) — the JSON list wins when present, so an
 * older agy without the field still surfaces its one sentinel-detected
 * denial unchanged. `null` when nothing was denied. This never changes
 * `status` or the exit code; job-helpers.mjs's `denialRemedy` turns each
 * `action` into the caller-facing remedy sentence.
 *
 * @param {import('./types.mjs').ProcessRequest & { platform?: NodeJS.Platform }} options
 * @returns {Promise<import('./types.mjs').RuntimeResult>}
 */
export async function runAgyPrint(rawOptions = {}) {
  const {
    prompt,
    mode,
    conversationId,
    cwd,
    addDirs,
    model,
    extraArgs,
    timeoutMs,
    bin,
    env,
    onStdout,
    onStderr,
    onText,
    onSpawn,
    signal,
    terminationGraceMs,
    forceKillGraceMs,
    maxStdoutBytes,
    maxStderrBytes,
    stdioDrainTimeoutMs,
    terminateTree,
    platform,
  } = normalizeRunOptions(rawOptions);

  if (typeof prompt !== 'string' || !prompt.length) {
    throw new TypeError('runAgyPrint: prompt must be a non-empty string');
  }
  const args = buildAgyArgs({ mode, conversationId, addDirs, model, extraArgs, timeoutMs });

  const detached = platform !== 'win32';
  const child = spawnAgy(bin, args, {
    cwd,
    env,
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session = createRunSession(child, { stdioDrainTimeoutMs, terminateTree, terminationGraceMs, forceKillGraceMs });
  wireAgyStreams(child, session, { maxStdoutBytes, maxStderrBytes, onStdout, onStderr, onText });

  session.timer = timeoutMs > 0
    ? setTimeout(() => {
      session.timer = null;
      session.initiateTermination('timeout', `agy did not finish within ${timeoutMs} ms`);
    }, timeoutMs)
    : null;

  // A detached agy no longer dies with the terminal's foreground process
  // group, so the interactive signals are forwarded to the same bounded
  // cancellation an abort uses (see forwardTerminationSignals).
  const removeSignalHandlers = detached
    ? forwardTerminationSignals(() => session.initiateTermination('cancelled'))
    : null;

  let abortListener;
  if (signal) {
    abortListener = () => session.initiateTermination('cancelled');
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  }

  let exitCode;
  try {
    exitCode = await writePromptAndAwaitExit({ child, session, prompt, onSpawn });
  } finally {
    clearSessionTimers(session);
    removeSignalHandlers?.();
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    await session.terminationTask;
  }

  return classifyRunResult({ session, exitCode });
}
