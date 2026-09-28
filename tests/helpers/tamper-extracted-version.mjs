/**
 * Preload for pack-for-agy version-mismatch tests (`node --import` this
 * file).
 *
 * Patches `fs.readFileSync` so a read of the *extracted* copy's
 * `package.json` (the tar output under `<tmp>/package/package.json`)
 * returns a version pack-for-agy.mjs did not itself write, without
 * touching any other `package.json` on disk — the real npm pack and real
 * tar extraction still run untouched; only what the verify step sees is
 * tampered. `scripts/pack-for-agy.mjs` reads via the default `fs` export
 * after this preload runs, so it sees the patched function.
 *
 * ANTIGRAVITY_TEST_TAMPER_VERSION — the bogus version string to report.
 */
import fs from 'node:fs';

const original = fs.readFileSync;
const EXTRACTED_PACKAGE_JSON_RE = /[\\/]package[\\/]package\.json$/;

fs.readFileSync = function readFileSync(file, options) {
  const dest = typeof file === 'string' ? file : String(file);
  const tamperedVersion = process.env.ANTIGRAVITY_TEST_TAMPER_VERSION;
  if (tamperedVersion && EXTRACTED_PACKAGE_JSON_RE.test(dest)) {
    const real = original.call(this, file, options);
    const json = JSON.parse(real.toString('utf8'));
    json.version = tamperedVersion;
    const text = JSON.stringify(json);
    return options ? text : Buffer.from(text, 'utf8');
  }
  return original.call(this, file, options);
};
