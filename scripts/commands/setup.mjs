/**
 * /antigravity:setup — interactive OAuth wizard.
 *
 * Spawns `agy --print 'noop'` in the foreground so the user sees the OAuth
 * URL and can paste the resulting code. Idempotent: a no-op when the token
 * cache is already valid.
 *
 * After that OAuth probe succeeds, also idempotently registers the vision
 * MCP server + permissions (scripts/lib/vision-config.mjs) so
 * `/antigravity:vision` works unattended. Pass `--skip-vision` to opt out.
 */
import { spawn } from 'node:child_process';
import { parseCommandInput } from '../lib/args.mjs';
import { resolveAgyBin, probeAgy } from '../lib/agent-runtime.mjs';
import { ensureVisionConfig } from '../lib/vision-config.mjs';
import { runIfMain } from '../lib/cli-entry.mjs';

export async function run(argv = [], ctx = {}) {
  const { options } = parseCommandInput(argv, {
    booleanOptions: ['skip-vision'],
  });

  const bin = resolveAgyBin();
  const probe = await probeAgy({ bin });
  if (!probe.ok) {
    process.stderr.write(
      `antigravity:setup — \`agy\` is not on PATH (${probe.reason}).\n` +
      `Install it from https://antigravity.google/download then re-run.\n`,
    );
    return 2;
  }

  process.stdout.write(`antigravity:setup — using ${bin} v${probe.version}\n`);
  process.stdout.write(`Triggering an authenticated probe. Complete the OAuth flow in your browser if prompted.\n\n`);

  const child = spawn(bin, ['--print', 'Reply with the word OK and nothing else.'], {
    stdio: 'inherit',
    cwd: ctx.cwd ?? process.cwd(),
    env: process.env,
  });

  const oauthCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (e) => {
      process.stderr.write(`antigravity:setup — spawn error: ${e.message}\n`);
      resolve(1);
    });
  });

  if (oauthCode !== 0) {
    return oauthCode;
  }

  if (options['skip-vision']) {
    process.stdout.write('\nantigravity:setup — --skip-vision passed; leaving vision config untouched.\n');
    return 0;
  }

  process.stdout.write('\nantigravity:setup — configuring vision (MCP server + permissions):\n');
  const { summary } = ensureVisionConfig();
  for (const line of summary) {
    process.stdout.write(`  - ${line}\n`);
  }

  return 0;
}

export default run;

runIfMain(import.meta.url, run);
