/**
 * Preload for file-lock mkdir-failure tests (`node --import` this file).
 *
 * Patches `fs.mkdirSync` for one exact lock path so acquisition can fail on
 * purpose without affecting the parent-directory setup call.
 *
 * ANTIGRAVITY_TEST_FAIL_MKDIR_PATH — exact lock path to fail.
 * ANTIGRAVITY_TEST_FAIL_MKDIR_CODE — synthetic Node filesystem error code.
 * ANTIGRAVITY_TEST_FAIL_MKDIR_ALWAYS — fail every matching attempt when `1`.
 */
import fs from "node:fs";

const original = fs.mkdirSync;
let matchingAttempts = 0;

fs.mkdirSync = function mkdirSync(target, options) {
  const dest = typeof target === "string" ? target : String(target);
  if (dest === process.env.ANTIGRAVITY_TEST_FAIL_MKDIR_PATH) {
    matchingAttempts += 1;
    if (matchingAttempts === 1 || process.env.ANTIGRAVITY_TEST_FAIL_MKDIR_ALWAYS === "1") {
      const err = new Error(`injected mkdir failure: ${dest}`);
      err.code = process.env.ANTIGRAVITY_TEST_FAIL_MKDIR_CODE;
      throw err;
    }
  }
  return original.call(this, target, options);
};

globalThis[Symbol.for("antigravity.test.mkdirAttempts")] = () => matchingAttempts;
