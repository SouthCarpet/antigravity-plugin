// Oracle: package J preserves every byte and exit code, and exits with no accepted write pending.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertJob, writeJobFile } from '../scripts/lib/state.mjs';
import { runOutput, assertDrained } from './helpers/slow-output.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
it('real dispatcher, direct command and worker drain slow stdout and stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-entry-'));
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(dir, 'data');
  try {
    const answer = 'large answer\n'.repeat(10000);
    const id = 'abcdef123456';
    await upsertJob(dir, { id, kind: 'task', status: 'completed', title: 'flush fixture' });
    await writeJobFile(dir, id, { id, kind: 'task', status: 'completed', request: {},
      result: { rawOutput: answer, stderr: '', status: 'completed', exitCode: 0 } });
    const bin = path.join(root, 'bin/antigravity.mjs');
    const cases = [
      [[bin, '--version'], 0], [[bin, '--help'], 0], [[bin, 'unknown-verb'], 2],
      [[bin, 'result', id, '--json'], 0], [[bin, 'result', 'missing-job'], 1],
      [[path.join(root, 'scripts/commands/result.mjs'), 'missing-job'], 1],
      [[path.join(root, 'scripts/commands/_worker.mjs')], 2],
    ];
    for (const [args, code] of cases) {
      const label = args.join(' ');
      const normal = await runOutput(args, dir, {}, false);
      const delayed = await runOutput(args, dir);
      assertDrained(delayed, label);
      assert.deepEqual({ code: delayed.code, stdout: delayed.stdout, stderr: delayed.stderr }, normal, label);
      assert.equal(delayed.code, code, label);
      if (args.includes(id)) {
        assert.ok(Buffer.byteLength(delayed.stdout) > 65536);
        assert.equal(JSON.parse(delayed.stdout).answer, answer);
      }
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
