/**
 * Preload for bump-version write-failure tests (`node --import` this file).
 *
 * Patches `fs.writeFileSync` so a later staging write can fail on purpose.
 * bump-version.mjs binds writeFileSync from the default `fs` export after
 * this preload runs, so it sees the patched function.
 *
 * ANTIGRAVITY_TEST_FAIL_WRITE — substring of the destination path that
 * should fail, only when the write is a sibling temp (`*.tmp`).
 */
import fs from 'node:fs';

const original = fs.writeFileSync;

fs.writeFileSync = function writeFileSync(file, data, options) {
  const needle = process.env.ANTIGRAVITY_TEST_FAIL_WRITE;
  const dest = typeof file === 'string' ? file : String(file);
  if (needle && dest.includes(needle) && dest.endsWith('.tmp')) {
    const err = new Error(`injected write failure: ${dest}`);
    err.code = 'EACCES';
    throw err;
  }
  return original.call(this, file, data, options);
};
