/**
 * Shared in-process stdout/stderr capture for tests that call `run()`
 * directly instead of spawning a child process.
 *
 * Node's own runtime warnings (`--experimental-test-module-mocks` and any
 * other `--experimental-*` flag) print lazily, the first time the feature
 * is actually used in the process, not at startup. `node --test` runs each
 * test file as its own process, so whichever test in a file first calls
 * `mock.module()` can have that one-time warning land on real
 * `process.stderr` in the middle of its own capture window. This helper
 * drops those lines before a test ever sees them, so an exact-string
 * stderr assertion does not depend on capture order within the file.
 */

const WARNING_LINE = /^\(node:\d+\) (?:ExperimentalWarning|Warning): .*$/;
const TRACE_WARNINGS_LINE = /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/;

function stripNodeWarningLines(chunk) {
  const hadTrailingNewline = chunk.endsWith('\n');
  const lines = chunk.split('\n');
  if (hadTrailingNewline) lines.pop(); // split() leaves one empty trailing entry
  const kept = lines.filter((line) => !WARNING_LINE.test(line) && !TRACE_WARNINGS_LINE.test(line));
  if (kept.length === 0) return '';
  return kept.join('\n') + (hadTrailingNewline ? '\n' : '');
}

export function captureStdio() {
  const out = [];
  const err = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return origStdout(chunk, ...rest);
    out.push(chunk);
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') return origStderr(chunk, ...rest);
    const filtered = stripNodeWarningLines(chunk);
    if (filtered !== '') err.push(filtered);
    return true;
  };
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}
