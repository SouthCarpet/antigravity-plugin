import fs from 'node:fs';
import { resolveJobLogFile } from './state.mjs';
import { createOAuthUrlFilter, removeOAuthUrlsDeep, safeFailureReason } from './safe-reason.mjs';
import { redactBypassFlag } from './render.mjs';

// Install before the worker module loads, so import failures are captured too.
const [, , jobId, workspaceRoot] = process.argv;
const MAX_DIAGNOSTIC_BYTES = 65536;
let written = 0;
let pending = '';
let fd;
function capture(text, flush = false) {
  if (written >= MAX_DIAGNOSTIC_BYTES) return;
  pending += String(text);
  if (!flush && !pending.includes('\n') && pending.length < 4096) return;
  const normalized = safeFailureReason(redactBypassFlag(pending));
  const reason = normalized === null ? null : redactBypassFlag(removeOAuthUrlsDeep(normalized));
  pending = '';
  if (!reason) return;
  const line = Buffer.from(`[worker] stderr: ${reason}\n`);
  const output = line.subarray(0, MAX_DIAGNOSTIC_BYTES - written);
  try {
    // A retained descriptor also avoids following a later replacement of the log path.
    fd ??= fs.openSync(resolveJobLogFile(workspaceRoot, jobId), 'a', 0o600);
    written += fs.writeSync(fd, output);
  } catch { /* Logging cannot prevent worker completion. */ }
}
const oauthFilter = createOAuthUrlFilter(capture);
process.stderr.write = (chunk, encoding, callback) => {
  if (written < MAX_DIAGNOSTIC_BYTES) {
    oauthFilter.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
  }
  const done = typeof encoding === 'function' ? encoding : callback;
  done?.();
  return true;
};
process.on('uncaughtExceptionMonitor', error => {
  oauthFilter.write(String(error?.stack ?? error));
  oauthFilter.flush();
  capture('', true);
});
process.on('exit', () => {
  oauthFilter.flush();
  capture('', true);
  if (fd !== undefined) {
    try { fs.closeSync(fd); } catch { /* Best-effort close during exit. */ }
  }
});
