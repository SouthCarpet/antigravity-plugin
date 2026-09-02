/**
 * process-adapter — the single owned seam between this plugin's spawn call
 * sites (agent-runtime.mjs, job-helpers.mjs, scripts/commands/setup.mjs) and
 * `node:child_process`.
 *
 * Tests fake THIS module instead of reaching into the `node:child_process`
 * builtin: `mock.module('node:child_process', ...)` replaces spawn for every
 * consumer of the builtin in the process, including ones a test never meant
 * to touch, and ties every test to Node's exact builtin export shape. Faking
 * a module this plugin owns keeps the fake's contract — `spawn(command,
 * args, options) -> ChildProcess`-shaped object — scoped to what these call
 * sites actually use.
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** @type {typeof import('node:child_process').spawn} */
export function spawn(command, args, options) {
  return nodeSpawn(command, args, options);
}
