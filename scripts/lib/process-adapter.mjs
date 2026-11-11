/**
 * process-adapter — the one place where this plugin starts a process. Every
 * shipped file reaches `node:child_process` through this module
 * (tests/spawn-inventory.test.mjs fails when another shipped file imports
 * the builtin).
 *
 * `spawn` and `spawnSync` set `windowsHide: true` on every call. The
 * background worker has no console, so on Windows each console program it
 * started (agy, `taskkill`, git) got a new console window, and Windows
 * handed that window to the default terminal application. With the option
 * the child gets no window. Node ignores the option on other platforms.
 *
 * What the option does on Windows depends on the child's stdio (libuv
 * `src/win/process.c`):
 *   - Every stream piped or ignored: the child gets a console of its own
 *     with no window. It no longer shares the caller's console, so a
 *     Ctrl+C in the caller's terminal does not reach it; agent-runtime.mjs
 *     forwards the terminal signals for that reason.
 *   - A stream inherited or given as a file descriptor: the child stays in
 *     the caller's console; a console created for it is hidden.
 *
 * Tests fake THIS module instead of reaching into the `node:child_process`
 * builtin: `mock.module('node:child_process', ...)` replaces spawn for every
 * consumer of the builtin in the process, including ones a test never meant
 * to touch, and ties every test to Node's exact builtin export shape. Faking
 * a module this plugin owns keeps the fake's contract — `spawn(command,
 * args, options) -> ChildProcess`-shaped object — scoped to what these call
 * sites actually use.
 */
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';

/**
 * The arguments for Node with `windowsHide: true` set. A caller's own
 * `windowsHide` value never wins. Node also accepts `(command, options)`;
 * that form keeps its meaning.
 *
 * @param {string[] | object} [args]
 * @param {object} [options]
 * @returns {[string[] | undefined, object]}
 */
function withHiddenWindow(args, options) {
  const optionsOnly = args !== null && typeof args === 'object' && !Array.isArray(args);
  return optionsOnly
    ? [[], { ...args, windowsHide: true }]
    : [args, { ...options, windowsHide: true }];
}

/**
 * @type {typeof import('node:child_process').spawn}
 * @param {string} command
 * @param {string[]} [args]
 * @param {object} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawn(command, args, options) {
  return nodeSpawn(command, ...withHiddenWindow(args, options));
}

/** Bounded synchronous probes and tools (git, `taskkill`, the start-time query). */
export function spawnSync(command, args, options) {
  return nodeSpawnSync(command, ...withHiddenWindow(args, options));
}

/**
 * The one exception: the sign-in run of `setup` (scripts/commands/setup.mjs).
 * It passes the caller's options to Node unchanged, so the interactive agy
 * process starts exactly as it did before the hide option existed. No other
 * file may call it (tests/spawn-inventory.test.mjs).
 *
 * @type {typeof import('node:child_process').spawn}
 */
export function spawnInteractive(command, args, options) {
  return nodeSpawn(command, args, options);
}
