/**
 * /antigravity:setup — interactive OAuth wizard.
 *
 * Spawns `agy --print 'noop'` in the foreground so the user sees the OAuth
 * URL and can paste the resulting code. Idempotent: a no-op when the token
 * cache is already valid.
 *
 * After that OAuth probe succeeds, also idempotently registers the vision
 * MCP server + permissions (scripts/lib/vision-config.mjs) so
 * `/antigravity:vision` works unattended. Pass `--skip-vision` to opt out,
 * or `--remove-vision` to remove only plugin-owned persistent entries.
 */
import { spawn } from 'node:child_process';
import { readCommandInput } from '../lib/args.mjs';
import { resolveAgyBin, probeAgy, assertAgyBinSpawnable } from '../lib/agent-runtime.mjs';
import { ensureVisionConfig, removeVisionConfig, VISION_PERMISSION } from '../lib/vision-config.mjs';
import { runIfMain } from '../lib/cli-entry.mjs';

export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    booleanOptions: ['skip-vision', 'remove-vision'],
  }, 'setup');
  if (!parsed) return 1;
  const { options } = parsed;

  if (options['remove-vision']) {
    process.stdout.write(
      'antigravity:setup — removing persistent vision configuration from ~/.gemini.\n' +
      'Only the MCP entry and permission recorded as plugin-owned will be removed; unrelated settings are preserved.\n',
    );
    const result = removeVisionConfig();
    for (const line of result.summary) process.stdout.write(`  - ${line}\n`);
    return result.ok === false ? 1 : 0;
  }

  const bin = resolveAgyBin();
  try {
    assertAgyBinSpawnable(bin);
  } catch (err) {
    process.stderr.write(`antigravity:setup — ${err?.message ?? err}\n`);
    return 1;
  }
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

  process.stdout.write(
    '\nantigravity:setup — enabling persistent vision access under ~/.gemini:\n' +
    `  - registers a user-wide MCP server named "vision" using this exact Node executable: ${process.execPath}\n` +
    `  - adds one user-wide headless allow rule: ${VISION_PERMISSION}\n` +
    '  - records plugin ownership so removal preserves pre-existing and unrelated settings\n' +
    '  - each vision run still limits the server to only the image paths named in that invocation\n' +
    'Undo these changes with: antigravity-plugin setup --remove-vision\n' +
    'Applying configuration:\n',
  );
  const { summary, ok } = ensureVisionConfig();
  for (const line of summary) {
    process.stdout.write(`  - ${line}\n`);
  }

  return ok === false ? 1 : 0;
}

export default run;

runIfMain(import.meta.url, run);
