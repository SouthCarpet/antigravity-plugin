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
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join, delimiter, extname } from 'node:path';

/** Default binary name. Override via env `AGY_BIN`. */
export const DEFAULT_AGY_BIN = 'agy';

// Bound retained agy transport output: 16 MiB stdout and 4 MiB stderr.
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 4 * 1024 * 1024;
export const STDIO_DRAIN_TIMEOUT_MS = 5_000;

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
 * @param {string} text - full accumulated stdout (or any concatenation of
 *   chunks — reassembly across chunk boundaries falls out of `\n`-splitting
 *   the joined string, so callers never need to pre-align chunks).
 * @returns {{ response: string|null, usage: object|null, durationSeconds: number|null,
 *   conversationId: string|null, resultStatus: string|null, resultError: string|null,
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
 *   `{"event":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}`
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
 * spawnError }`. `spawnError` is the child's `error` event message (for
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
 * @param {import('./types.mjs').ProcessRequest & { platform?: NodeJS.Platform }} options
 * @returns {Promise<import('./types.mjs').RuntimeResult>}
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
  onSpawn,
  signal,
  terminationGraceMs = 500,
  forceKillGraceMs = 500,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
  stdioDrainTimeoutMs = STDIO_DRAIN_TIMEOUT_MS,
  terminateTree = terminateProcessTree,
  platform = process.platform,
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

  const detached = platform !== 'win32';
  const child = spawnAgy(bin, args, {
    cwd,
    env,
    detached,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let oauthUrl;
  let status;
  let spawnError = null;
  let timer = null;
  let drainTimer = null;
  let giveUpTimer = null;
  let terminationTask;
  let terminationReason = null;
  let errorMessage = null;
  let settleExit;
  let settled = false;
  let exited = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const warnings = [];
  // Destroying is not enough to let this process exit: the pending shutdown
  // of the stdin pipe (from `stdin.end()`) stays an active handle while a
  // grandchild that inherited the descriptors keeps it open, so the handles
  // are also unreferenced. Without the unref, a library caller settles at the
  // drain deadline but only exits when that grandchild does.
  const destroyStdio = () => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.destroy?.();
      stream?.unref?.();
    }
  };

  const exitCodePromise = new Promise((resolve) => {
    settleExit = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(giveUpTimer);
      resolve(code);
    };
    child.on('error', (e) => {
      if (settled) return;
      spawnError = e.message;
      stderr += `\nspawn error: ${e.message}`;
      settleExit(typeof e.errno === 'number' ? e.errno : 1);
    });
    child.on('close', (code, signal) => settleExit(code ?? (signal ? 1 : 0)));
    child.on('exit', (code, signal) => {
      exited = true;
      if (settled) return;
      drainTimer = setTimeout(() => {
        warnings.push(`agy stdio did not close within ${stdioDrainTimeoutMs} ms after exit`);
        destroyStdio();
        settleExit(code ?? (signal ? 1 : 0));
      }, stdioDrainTimeoutMs);
    });
  });

  child.stdin.on('error', (e) => {
    // EPIPE if agy exits before we finish writing the prompt line — record
    // it, never let it surface as an unhandled 'error' event. Newline-
    // terminated: the child's own stderr usually arrives after this.
    stderr += `\nstdin error: ${e.message}\n`;
  });
  const lineFeeder = onText ? createNdjsonLineFeeder() : null;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (settled || terminationReason === 'output_limit') return;
    stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (stdoutBytes > maxStdoutBytes) {
      initiateTermination('output_limit', `agy output exceeded ${maxStdoutBytes} bytes`);
      return;
    }
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
    if (settled || terminationReason === 'output_limit') return;
    stderrBytes += Buffer.byteLength(chunk, 'utf8');
    if (stderrBytes > maxStderrBytes) {
      initiateTermination('output_limit', `agy output exceeded ${maxStderrBytes} bytes`);
      return;
    }
    stderr += chunk;
    onStderr?.(chunk);
  });

  const initiateTermination = (reason, message = null) => {
    if (settled || terminationReason) return;
    terminationReason = reason;
    status = reason === 'output_limit' ? 'failed' : reason;
    errorMessage = message;
    terminationTask = terminateTree(child.pid, {
      graceMs: terminationGraceMs,
      forceGraceMs: forceKillGraceMs,
    }).catch((err) => {
      stderr += `\nprocess tree termination failed: ${err.message}`;
    }).then(() => {
      if (!settled && !exited) {
        // A disappeared PID can precede Node's exit/close events. Give those
        // events a bounded turn to arrive before abandoning the handle.
        giveUpTimer = setTimeout(() => {
          if (settled || exited) return; // exit owns the separate drain deadline
          stderr += '\nagent-runtime: child did not exit after SIGKILL escalation';
          destroyStdio();
          child.unref?.();
          settleExit(124);
        }, forceKillGraceMs);
      }
    });
  };

  timer = timeoutMs > 0
    ? setTimeout(() => initiateTermination('timeout', `agy did not finish within ${timeoutMs} ms`), timeoutMs)
    : null;

  // A detached agy no longer dies with the terminal's foreground process
  // group, so the interactive signals are forwarded to the same bounded
  // cancellation an abort uses (see forwardTerminationSignals).
  const removeSignalHandlers = detached
    ? forwardTerminationSignals(() => initiateTermination('cancelled'))
    : null;

  let abortListener;
  if (signal) {
    abortListener = () => initiateTermination('cancelled');
    if (signal.aborted) abortListener();
    else signal.addEventListener('abort', abortListener, { once: true });
  }

  let exitCode;
  try {
    try {
      await onSpawn?.({ pid: child.pid ?? null, child });
    } catch (err) {
      initiateTermination('failed');
      await exitCodePromise;
      throw err;
    }
    if (!settled && !terminationReason) {
      child.stdin.write(buildStreamJsonLine(prompt) + '\n');
      child.stdin.end();
    }
    exitCode = await exitCodePromise;
  } finally {
    clearTimeout(timer);
    clearTimeout(drainTimer);
    clearTimeout(giveUpTimer);
    removeSignalHandlers?.();
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    await terminationTask;
  }

  const parsed = parseAgyStream(stdout);

  // A SUCCESS result quoting the OAuth URL mid-answer is not an auth
  // failure (item 14): a completed review of a change that touches Google
  // sign-in can legitimately echo that URL. `eligible` decides whether a
  // response is trustworthy as an auth signal at all: never for a legitimate
  // long SUCCESS answer that merely contains the URL text, only when it
  // looks like agy's own short sentinel line (under 512 chars, first line
  // matching AUTH_LINE_PATTERNS) or the run did not succeed — agy's own
  // failure text has no length promise.
  // NOTE: this SUCCESS-response path is exercised only against recorded
  // fixtures — the live auth response shape on agy 1.1.24 (whether a prompt
  // ever actually arrives inside a SUCCESS result, or only ever as raw
  // stdout) was not re-probed for this change. See
  // tests/agent-runtime-stream.test.mjs "flags auth_required for a short
  // SUCCESS sentinel matching AUTH_LINE_PATTERNS" for the shapes this pins
  // today.
  const responseText = typeof parsed.response === 'string' ? parsed.response : '';
  const responseFirstLine = responseText.split('\n', 1)[0];
  const looksLikeAuthSentinel = AUTH_LINE_PATTERNS.some((p) => p.test(responseFirstLine));
  const eligible = parsed.resultStatus !== 'SUCCESS' ||
    (responseText.length < 512 && looksLikeAuthSentinel);

  // The per-chunk raw-stdout scan above runs while the stream is still
  // arriving, before parsing can know whether this text will turn out to be
  // a SUCCESS result's response field — so it can speculatively set
  // `auth_required` on exactly the long-answer-mentions-the-URL case this
  // fix targets. Undo that speculative call once the full result is parsed
  // and it turns out not to be eligible; the raw-stdout detection itself
  // (the chunk scan) is unchanged.
  if (status === 'auth_required' && parsed.sawResult && !eligible) {
    status = undefined;
    oauthUrl = undefined;
  }

  // Auth prompts may also arrive folded into the result event's response
  // field without ever matching at the raw-chunk level (e.g. reassembled
  // only after a chunk boundary split the URL) — check it here too.
  if (!status && eligible) {
    const m = responseText.match(AUTH_URL_PATTERN);
    if (m || looksLikeAuthSentinel) {
      oauthUrl = oauthUrl ?? m?.[1];
      status = 'auth_required';
    }
  }

  let denial = null;
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
      denial = detectAutoDenial(stderr);
      const answered = typeof parsed.response === 'string' && parsed.response.trim().length > 0;
      if (denial && !answered) {
        status = 'failed';
        stderr +=
          `\nagent-runtime: agy produced no output because the "${denial.tool}" tool was ` +
          `auto-denied (headless mode cannot prompt for it)`;
      } else {
        status = 'completed';
        if (denial) warnings.push(denial.line);
      }
    }
    stderr += agyResultErrorNote(parsed.resultError);
  }

  return {
    status,
    stderr: errorMessage ? `${stderr}\n${errorMessage}` : stderr,
    errorMessage,
    exitCode,
    oauthUrl,
    stdout: terminationReason === 'output_limit' ? stdout
      : parsed.sawResult && typeof parsed.response === 'string' ? parsed.response : stdout,
    rawStdout: stdout,
    usage: parsed.usage ?? null,
    durationSeconds: parsed.durationSeconds ?? null,
    agyConversationId: parsed.conversationId ?? null,
    warnings,
    denial,
    spawnError,
  };
}
