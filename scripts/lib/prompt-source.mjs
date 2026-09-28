/**
 * `task --prompt-file <path>` / `--prompt-file -` (stdin) prompt-source
 * resolution (Senate R13, 2026-09).
 *
 * Reading only ever happens here: `task.mjs#run` asks this module for the
 * resolved prompt text (or a validation failure) and never touches the
 * filesystem or stdin itself. Split out of `task.mjs` so `run()` stays a
 * thin sequence of checks under the project's cyclomatic-complexity
 * ceiling, the same reason `request-id.mjs` and `vision-capability.mjs`
 * exist as their own modules for their own verb.
 *
 * SECURITY.md promises the named file is the only thing read, and that
 * neither the path nor the prompt content ever reaches a diagnostic: every
 * message this module returns is a fixed string plus numbers (byte counts),
 * never the path or the file/stdin content itself.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { HOST_WRAPPER_ENV } from "./job-helpers.mjs";

/** Reading (file or stdin) refuses anything larger than this many bytes. */
export const MAX_PROMPT_FILE_BYTES = 512 * 1024;

/** The `--prompt-file` value that means "read the prompt from stdin". */
export const PROMPT_FILE_STDIN = "-";

const TOO_LARGE_CODE = "prompt_file_too_large";
const UNREADABLE_CODE = "prompt_file_unreadable";
const EMPTY_CODE = "prompt_file_empty";

const UNREADABLE_ERROR = Object.freeze({
  ok: false,
  code: UNREADABLE_CODE,
  message: "the named prompt file could not be found or read",
});

const EMPTY_ERROR = Object.freeze({
  ok: false,
  code: EMPTY_CODE,
  message: "the prompt source is empty or contains only whitespace",
});

/**
 * @param {number} actualBytes
 * @returns {{ ok: false, code: string, message: string }}
 */
function tooLargeError(actualBytes) {
  return {
    ok: false,
    code: TOO_LARGE_CODE,
    message: `the prompt source exceeds the ${MAX_PROMPT_FILE_BYTES}-byte limit (actual: ${actualBytes} bytes)`,
  };
}

/**
 * `-prompt-file - ` reads stdin only from the standalone CLI, run directly
 * by a human or script — never from a host wrapper (Claude Code, Codex, the
 * agy TUI), which owns stdio for its own protocol and never leaves a pipe
 * free for this. `bin/antigravity.mjs` is the only caller that passes
 * `{ host: "standalone" }`; every host wrapper also sets
 * `ANTIGRAVITY_HOST_WRAPPER` (`host-bootstrap.cjs`), checked as a second,
 * independent signal in case a future standalone entry point ever forgets
 * to set `host`.
 *
 * @param {{ host?: string }} [ctx]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function stdinPromptFileAllowed(ctx = {}, env = process.env) {
  return ctx.host === "standalone" && !env[HOST_WRAPPER_ENV];
}

/**
 * Post-parse validation for `--prompt-file` that the declarative
 * `args.mjs` schema keys cannot express: a positional prompt together with
 * the flag, and `-` outside the standalone CLI. Mirrors
 * `job-helpers.mjs#validateShowResultDependency`'s shape (a message string
 * or `null`, reported through `reportArgsValidationError`) — a plain
 * post-parse check `task.mjs#run` runs once, right after
 * `readCommandInput`, rather than a `schema.validate` hook (which only
 * ever sees `options`, not `positionals` or `ctx`).
 *
 * @param {{ options: Record<string, string | boolean | string[]>, positionals: string[] }} parsed
 * @param {{ host?: string }} [ctx]
 * @returns {string | null}
 */
export function validatePromptFileOption({ options, positionals }, ctx = {}) {
  const promptFile = options["prompt-file"];
  if (promptFile === undefined) return null;
  if (positionals.length > 0) return "cannot combine --prompt-file with a positional prompt";
  if (promptFile === PROMPT_FILE_STDIN && !stdinPromptFileAllowed(ctx)) {
    return "--prompt-file - (stdin) is available in the standalone CLI only";
  }
  return null;
}

/**
 * Strip exactly one trailing newline (`\n` or `\r\n`) — the interface's
 * "no trimming beyond a trailing newline strip". Everything else in the
 * file/stdin content reaches the model verbatim.
 *
 * @param {string} text
 * @returns {string}
 */
function stripOneTrailingNewline(text) {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * @param {Buffer} buffer already confirmed to be within the byte cap
 * @returns {{ ok: true, text: string } | { ok: false, code: string, message: string }}
 */
function finalizeContent(buffer) {
  const text = stripOneTrailingNewline(buffer.toString("utf8"));
  if (text.trim() === "") return { ...EMPTY_ERROR };
  return { ok: true, text };
}

/**
 * Read `--prompt-file <path>`'s content: resolved against the invocation
 * cwd (`resolveCliCwd`'s result — never the workspace root, which
 * `resolveWorkspaceRoot` may walk upward to find), UTF-8, capped at
 * {@link MAX_PROMPT_FILE_BYTES}. The size check runs off `stat` before any
 * `readFileSync`, so an oversized file is refused without reading it into
 * memory.
 *
 * @param {string} rawPath
 * @param {string} cwd invocation cwd
 * @returns {{ ok: true, text: string } | { ok: false, code: string, message: string }}
 */
export function readPromptFile(rawPath, cwd) {
  const absPath = resolvePath(cwd, rawPath);
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return { ...UNREADABLE_ERROR };
  }
  if (!stat.isFile()) return { ...UNREADABLE_ERROR };
  if (stat.size > MAX_PROMPT_FILE_BYTES) return tooLargeError(stat.size);
  let buffer;
  try {
    buffer = readFileSync(absPath);
  } catch {
    return { ...UNREADABLE_ERROR };
  }
  return finalizeContent(buffer);
}

/**
 * Read stdin to EOF, capped at {@link MAX_PROMPT_FILE_BYTES} (the
 * interface's "Stdin is read to EOF with the same cap"). Drains the whole
 * stream even past the cap, so a `prompt_file_too_large` message's actual
 * byte count is the real total, not however many bytes happened to fit
 * before the cap was noticed.
 *
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string, message: string }>}
 */
export async function readPromptStdin(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total <= MAX_PROMPT_FILE_BYTES) chunks.push(chunk);
  }
  if (total > MAX_PROMPT_FILE_BYTES) return tooLargeError(total);
  return finalizeContent(Buffer.concat(chunks));
}

/**
 * Resolve `task`'s prompt source: `--prompt-file <path>`, `--prompt-file -`
 * (stdin), or `null` when the flag was not given at all (the caller falls
 * back to its own positional-prompt handling). `validatePromptFileOption`
 * must already have passed for this to run.
 *
 * @param {Record<string, string | boolean | string[]>} options parsed CLI options
 * @param {string} cwd invocation cwd
 * @param {{ stdin?: NodeJS.ReadableStream }} [opts] test override for stdin
 * @returns {Promise<null | { ok: true, text: string } | { ok: false, code: string, message: string }>}
 */
export async function resolvePromptFileSource(options, cwd, { stdin = process.stdin } = {}) {
  const promptFile = options["prompt-file"];
  if (promptFile === undefined) return null;
  if (promptFile === PROMPT_FILE_STDIN) return readPromptStdin(stdin);
  return readPromptFile(String(promptFile), cwd);
}

/**
 * `task`'s title for a prompt-file/stdin source: 80-char truncation of the
 * first non-empty line, distinct from the positional path's whole-string
 * truncation (`task.mjs#truncate`) because file/stdin content is routinely
 * multi-line, unlike a positional prompt joined from argv words.
 *
 * @param {string} text non-empty (`resolvePromptFileSource` never returns
 *   `ok: true` for empty/whitespace-only content)
 * @returns {string}
 */
export function titleFromPromptText(text) {
  const line = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
