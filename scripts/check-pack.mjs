#!/usr/bin/env node
/**
 * Assert `npm pack` would ship what the four advertised hosts need.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  { path: 'package.json', why: 'standalone package identity' },
  { path: 'plugin.json', why: 'agy / root manifest' },
  { path: 'bin/antigravity.mjs', why: 'standalone CLI' },
  { path: '.claude-plugin/plugin.json', why: 'Claude Code plugin manifest' },
  { path: '.claude-plugin/marketplace.json', why: 'Claude Code marketplace' },
  { path: '.codex-plugin/plugin.json', why: 'Codex CLI plugin manifest' },
  { path: 'SKILL.md', why: 'Codex skill-discovery entry' },
  { path: '.agents/plugins/marketplace.json', why: 'Codex marketplace descriptor' },
  { path: 'agents/openai.yaml', why: 'Codex $antigravity interface' },
  { path: 'commands/rescue.md', why: 'Claude Code slash commands' },
  { path: 'scripts/commands/rescue.mjs', why: 'shared verb runtime' },
  { path: 'scripts/lib/agent-runtime.mjs', why: 'shared library' },
  { path: 'scripts/mcp/vision-server.mjs', why: 'vision MCP server' },
];

const prefixes = [
  { prefix: 'commands/', why: 'host command markdown' },
  { prefix: 'scripts/commands/', why: 'verb implementations' },
  { prefix: 'scripts/lib/', why: 'shared runtime' },
];

const npm =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/c', 'npm pack --dry-run --json'], {
        cwd: root,
        encoding: 'utf8',
      })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: root,
        encoding: 'utf8',
      });

if (npm.status !== 0) {
  console.error('npm pack --dry-run --json failed');
  if (npm.stderr) process.stderr.write(npm.stderr);
  if (npm.stdout) process.stdout.write(npm.stdout);
  process.exit(npm.status === null ? 1 : npm.status);
}

let parsed;
try {
  parsed = JSON.parse(npm.stdout);
} catch (err) {
  console.error(`could not parse npm pack JSON: ${err.message}`);
  process.stderr.write(npm.stdout);
  process.exit(1);
}

const pack = Array.isArray(parsed) ? parsed[0] : parsed;
const files = new Set((pack.files ?? []).map((entry) => entry.path.replace(/\\/g, '/')));

console.log(`npm pack would produce ${pack.filename} (${files.size} files)`);

const missingRequired = [];
for (const item of required) {
  if (!files.has(item.path)) {
    missingRequired.push(item);
  }
}
for (const item of prefixes) {
  const hit = [...files].some(
    (p) => p === item.prefix.slice(0, -1) || p.startsWith(item.prefix),
  );
  if (!hit) missingRequired.push({ path: `${item.prefix}*`, why: item.why });
}

if (missingRequired.length > 0) {
  console.error('missing required pack entries:');
  for (const item of missingRequired) {
    console.error(`  ${item.path} — ${item.why}`);
  }
}

if (missingRequired.length > 0) {
  process.exit(1);
}

console.log('ok: required pack entries for Claude Code, Codex CLI, agy, and standalone are present');
