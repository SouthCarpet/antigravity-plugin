#!/usr/bin/env node
/**
 * Assert `npm pack` would ship what the four advertised hosts need.
 *
 * The required set is derived from the tree, not sampled:
 *
 *   1. Host discovery files — every file currently sitting at a well-known
 *      host path (`.claude-plugin/`, `.codex-plugin/`, `.agents/`, `agents/`,
 *      plus `plugin.json`, `SKILL.md`, `package.json`, `bin/antigravity.mjs`).
 *      Hosts look these up by location; adding a file to one of those trees
 *      automatically tightens this gate.
 *   2. Every `commands/*.md` — Claude Code and agy TUI slash-command
 *      discovery. Dropping
 *      `commands/vision.md` from `files` is the failure the old representative
 *      list missed.
 *   3. Every `scripts/commands/*.mjs` — the modules those markdown files
 *      invoke, including `_worker.mjs` (spawned by job-helpers, not a user
 *      verb).
 *   4. Every `scripts/mcp/*.mjs` — MCP servers the plugin registers by path
 *      (`vision-config` resolves `vision-server.mjs` at runtime).
 *   5. The static import graph of (3), (4), and `bin/antigravity.mjs`, plus
 *      relative `.mjs` string literals in those files (`new URL("…")`).
 *   6. `CHANGELOG.md`, and every markdown file the README links to with a
 *      relative link that resolves inside the package. An installed copy
 *      shows the README first: a link from it to a file the tarball omits
 *      is a dead link, and the Troubleshooting table cannot be read offline.
 *      The list comes from the README, so a new documentation link tightens
 *      this gate by itself.
 *
 * The walk follows static `from`/`import` specifiers and literal
 * `import("…")` / `import('…')`. It cannot see a computed specifier
 * (`import(pathToFileURL(modPath).href)`, `import(parts.join(""))`, and
 * so on). A maintainer who adds one must put its target in an explicit
 * rule above — a glob or a named path — or the tarball can omit it and
 * this gate will still pass.
 *
 * One computed import exists today: `bin/antigravity.mjs` loads
 * `scripts/commands/<verb>.mjs` via `import(pathToFileURL(modPath).href)`.
 * The `scripts/commands/*.mjs` rule already requires every target, so that
 * case is covered by construction, not by walking the specifier.
 *
 * Detecting computed specifiers reliably needs parser context a text
 * scanner does not have. That work is a candidate for a later minor
 * release; revisit it if a bug appears that this blindness would have
 * caught, or if a new Antigravity release changes how modules are loaded.
 *
 * A reader can re-run the derivation: if a command markdown, verb module,
 * MCP server, or imported library file exists on disk, it is required in
 * the tarball. Prefix wildcards ("at least one file under commands/") are
 * gone.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function listFiles(relDir, predicate) {
  const absDir = join(root, relDir);
  if (!existsSync(absDir)) return [];
  const out = [];
  const stack = [relDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const abs = join(root, current);
    for (const name of readdirSync(abs)) {
      const rel = toPosix(join(current, name));
      const st = statSync(join(root, rel));
      if (st.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!st.isFile()) continue;
      if (predicate && !predicate(name, rel)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

function add(required, path, why) {
  const rel = toPosix(path);
  if (!required.has(rel)) required.set(rel, why);
}

/**
 * Follow relative ESM specifiers and relative `.mjs` string literals.
 * `node:` / package imports are ignored; paths that resolve outside the
 * package root are ignored.
 */
function walkImportGraph(entryRels) {
  const FROM_RE = /\b(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g;
  const IMPORT_CALL_RE = /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  const MJS_REL_RE = /['"](\.\.?\/[^'"\n]+\.mjs)['"]/g;

  const seen = new Set();
  const reachable = [];
  const queue = [...entryRels];

  while (queue.length > 0) {
    const rel = toPosix(queue.pop());
    if (seen.has(rel)) continue;
    seen.add(rel);
    reachable.push(rel);
    if (!rel.endsWith('.mjs')) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    const specs = [];
    for (const re of [FROM_RE, IMPORT_CALL_RE, MJS_REL_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) specs.push(m[1]);
    }
    for (const spec of specs) {
      let resolved = toPosix(relative(root, normalize(join(root, dirname(rel), spec))));
      if (resolved.startsWith('../') || resolved === '..') continue;
      if (!resolved.endsWith('.mjs') && !resolved.endsWith('.json')) {
        if (existsSync(join(root, `${resolved}.mjs`))) resolved = `${resolved}.mjs`;
      }
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return reachable;
}

/**
 * Every markdown file the README links to with a relative link, as package
 * relative posix paths. A fragment (`#section`) is stripped, a link that
 * escapes the package root is dropped, and a target that is not on disk is
 * dropped: this gate is about the tarball, not about broken links.
 */
export function listReadmeLinkedDocs(readmeRel = 'README.md') {
  const abs = join(root, readmeRel);
  if (!existsSync(abs)) return [];
  const src = readFileSync(abs, 'utf8');
  const LINK_RE = /\]\(\s*(\.{0,2}\/[^)\s#]+|[A-Za-z0-9_][^):\s#]*)\s*(?:#[^)\s]*)?\)/g;
  const out = new Set();
  let match;
  while ((match = LINK_RE.exec(src))) {
    const target = match[1];
    if (!target.endsWith('.md')) continue;
    const resolved = toPosix(relative(root, normalize(join(root, dirname(readmeRel), target))));
    if (resolved.startsWith('../') || resolved === '..') continue;
    if (!existsSync(join(root, resolved))) continue;
    out.add(resolved);
  }
  return [...out].sort();
}

export function deriveRequired() {
  const required = new Map();

  add(required, 'package.json', 'standalone package identity');
  add(required, 'plugin.json', 'agy / root manifest');
  add(required, 'bin/antigravity.mjs', 'standalone CLI');
  add(required, 'SKILL.md', 'Codex skill-discovery entry');

  const discoveryTrees = [
    ['.claude-plugin', 'Claude Code host discovery (.claude-plugin/)'],
    ['.codex-plugin', 'Codex CLI host discovery (.codex-plugin/)'],
    ['.agents', 'Codex marketplace descriptor (.agents/)'],
    ['agents', 'Codex $antigravity interface (agents/)'],
  ];
  for (const [dir, why] of discoveryTrees) {
    for (const rel of listFiles(dir)) add(required, rel, why);
  }

  for (const rel of listFiles('commands', (name) => name.endsWith('.md'))) {
    add(required, rel, 'Claude Code slash command (commands/*.md)');
  }

  const commandModules = listFiles('scripts/commands', (name) => name.endsWith('.mjs'));
  for (const rel of commandModules) {
    add(required, rel, 'verb module (scripts/commands/*.mjs)');
  }

  const mcpModules = listFiles('scripts/mcp', (name) => name.endsWith('.mjs'));
  for (const rel of mcpModules) {
    add(required, rel, 'MCP server (scripts/mcp/*.mjs)');
  }

  add(required, 'README.md', 'the first thing an installed copy shows');
  add(required, 'CHANGELOG.md', 'release history, linked from the README');
  for (const rel of listReadmeLinkedDocs()) {
    add(required, rel, 'README link target (a README-linked .md must not be a dead link)');
  }

  const graphEntries = ['bin/antigravity.mjs', ...commandModules, ...mcpModules];
  for (const rel of walkImportGraph(graphEntries)) {
    add(required, rel, 'reachable from bin/antigravity.mjs, a command module, or an MCP server');
  }

  return required;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  let modulePath;
  let entryPath;
  try {
    modulePath = resolve(fileURLToPath(import.meta.url));
    entryPath = resolve(entry);
  } catch {
    return false;
  }
  if (process.platform === 'win32') {
    return modulePath.toLowerCase() === entryPath.toLowerCase();
  }
  return modulePath === entryPath;
}

function runCli() {
  const required = deriveRequired();

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
  console.log(
    `derived ${required.size} required entries from host discovery, commands/*.md, ` +
      `scripts/commands/*.mjs, scripts/mcp/*.mjs, the import graph, and the README links`,
  );

  const missingRequired = [];
  for (const [relPath, why] of required) {
    if (!files.has(relPath)) missingRequired.push({ path: relPath, why });
  }

  if (missingRequired.length > 0) {
    console.error('missing required pack entries:');
    for (const item of missingRequired) {
      console.error(`  ${item.path} — ${item.why}`);
    }
    process.exit(1);
  }

  console.log('ok: required pack entries for Claude Code, Codex CLI, agy, and standalone are present');
}

if (isMainModule()) runCli();
