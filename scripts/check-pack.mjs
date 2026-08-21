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
 *
 * The walk follows static `from`/`import` specifiers, literal
 * `import("…")` / `import('…')`, and relative `.mjs` string literals. It
 * does not evaluate computed specifiers (`import(pathToFileURL(modPath).href)`,
 * `import(parts.join(""))`, and so on). Guessing those is how a pack gate
 * starts lying, so a computed `import()` in a walked module fails the gate
 * unless a maintainer has named that specific call in NAMED_COMPUTED_IMPORTS
 * (file + specifier text) and the named prefix is already required by an
 * explicit rule above — not by the walk itself. One named call in a file
 * does not authorize a second.
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
 * Computed `import()` calls whose targets are already required by an
 * explicit rule. The walk cannot resolve these specifiers; naming them
 * here is the honest alternative to guessing. Do not add an entry to
 * silence a hole — the named prefix must already be in the required set
 * from a glob or other explicit rule.
 *
 * Each entry authorizes one occurrence: same file, specifier text matching
 * `specifier`, and a required path with `requiredPrefix`. A second computed
 * import in that file — even with the same specifier — needs its own entry.
 *
 * `bin/antigravity.mjs` loads `scripts/commands/<verb>.mjs` via
 * `await import(pathToFileURL(modPath).href)`. The `scripts/commands/*.mjs`
 * glob already requires every target.
 */
const NAMED_COMPUTED_IMPORTS = [
  {
    file: 'bin/antigravity.mjs',
    specifier: /^pathToFileURL\s*\(\s*modPath\s*\)\s*\.\s*href$/,
    requiredPrefix: 'scripts/commands/',
  },
];

function lineNumberAt(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Replace comments and string contents with spaces (newlines kept) so
 * `import()` in a comment or string is not treated as a computed specifier.
 * Template-literal interpolations `${...}` are executable code and are
 * scanned, not masked; they nest (templates inside interpolations, braces
 * inside interpolations). Length-preserving so indices map back.
 */
function maskCommentsAndStrings(src) {
  return maskCode(src, 0, src.length, false).out;
}

function maskCode(src, start, end, stopOnBrace) {
  let out = '';
  let i = start;
  let braceDepth = 0;
  while (i < end) {
    if (src.startsWith('/*', i)) {
      const blockEnd = src.indexOf('*/', i + 2);
      const close = blockEnd === -1 ? end : Math.min(end, blockEnd + 2);
      out += src.slice(i, close).replace(/[^\n]/g, ' ');
      i = close;
      continue;
    }
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      const close = nl === -1 || nl > end ? end : nl;
      out += ' '.repeat(close - i);
      i = close;
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'") {
      const masked = maskQuoted(src, i, end, q);
      out += masked.out;
      i = masked.i;
      continue;
    }
    if (q === '`') {
      const masked = maskTemplate(src, i, end);
      out += masked.out;
      i = masked.i;
      continue;
    }
    if (stopOnBrace) {
      if (src[i] === '{') {
        braceDepth += 1;
      } else if (src[i] === '}') {
        if (braceDepth === 0) return { out, i };
        braceDepth -= 1;
      }
    }
    out += src[i];
    i += 1;
  }
  return { out, i };
}

function maskQuoted(src, i, end, q) {
  let out = q;
  i += 1;
  while (i < end && src[i] !== q) {
    if (src[i] === '\\' && i + 1 < end) {
      out += '  ';
      i += 2;
      continue;
    }
    out += src[i] === '\n' ? '\n' : ' ';
    i += 1;
  }
  if (i < end) {
    out += src[i];
    i += 1;
  }
  return { out, i };
}

function maskTemplate(src, i, end) {
  let out = '`';
  i += 1;
  while (i < end) {
    if (src[i] === '\\' && i + 1 < end) {
      out += '  ';
      i += 2;
      continue;
    }
    if (src[i] === '`') {
      out += '`';
      i += 1;
      return { out, i };
    }
    if (src[i] === '$' && i + 1 < end && src[i + 1] === '{') {
      out += '${';
      i += 2;
      const inner = maskCode(src, i, end, true);
      out += inner.out;
      i = inner.i;
      if (i < end && src[i] === '}') {
        out += '}';
        i += 1;
      }
      continue;
    }
    out += src[i] === '\n' ? '\n' : ' ';
    i += 1;
  }
  return { out, i };
}

/**
 * `import(` whose first argument is not a string literal. Template
 * literals, concatenation, and other expressions all count. Does not
 * evaluate the specifier. Comments and strings are masked first.
 */
function skipSpace(s, i) {
  while (i < s.length && /[ \t\r\n]/.test(s[i])) i += 1;
  return i;
}

function consumeStringLiteral(s, i) {
  const q = s[i];
  if (q !== "'" && q !== '"') return -1;
  i += 1;
  while (i < s.length && s[i] !== q) {
    if (s[i] === '\\') i += 1;
    i += 1;
  }
  if (i >= s.length) return -1;
  return i + 1;
}

function firstImportArgument(src, code, openParenIndex) {
  let depth = 0;
  const start = openParenIndex + 1;
  for (let i = openParenIndex; i < code.length; i++) {
    if (code[i] === '(') {
      depth += 1;
      continue;
    }
    if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i).trim();
    }
  }
  return src.slice(start).trim();
}

function findComputedDynamicImports(rel, src) {
  const hits = [];
  const code = maskCommentsAndStrings(src);
  const re = /\bimport\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const openParen = m.index + m[0].length - 1;
    let i = skipSpace(code, openParen + 1);
    const afterString = consumeStringLiteral(code, i);
    if (afterString !== -1) {
      i = skipSpace(code, afterString);
      if (code[i] === ')' || code[i] === ',') continue;
    }
    hits.push({
      file: rel,
      line: lineNumberAt(src, m.index),
      specifier: firstImportArgument(src, code, openParen),
    });
  }
  return hits;
}

/**
 * Each NAMED_COMPUTED_IMPORTS entry matches at most one hit. A second
 * computed import in an already-named file stays unnamed so it fails
 * closed with its own file:line.
 */
function unnamedComputedImports(hits, requiredPaths, named = NAMED_COMPUTED_IMPORTS) {
  const remaining = named.map((entry) => ({ ...entry, used: false }));
  const unnamed = [];
  for (const hit of hits) {
    const idx = remaining.findIndex(
      (entry) =>
        !entry.used &&
        entry.file === hit.file &&
        entry.specifier.test(hit.specifier) &&
        requiredPaths.some((relPath) => relPath.startsWith(entry.requiredPrefix)),
    );
    if (idx === -1) unnamed.push(hit);
    else remaining[idx].used = true;
  }
  return unnamed;
}

/**
 * Follow relative ESM specifiers and relative `.mjs` string literals.
 * `node:` / package imports are ignored; paths that resolve outside the
 * package root are ignored. Computed `import()` specifiers are collected,
 * not resolved.
 */
function walkImportGraph(entryRels) {
  const FROM_RE = /\b(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g;
  const IMPORT_CALL_RE = /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  const MJS_REL_RE = /['"](\.\.?\/[^'"\n]+\.mjs)['"]/g;

  const seen = new Set();
  const reachable = [];
  const computedImports = [];
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
    computedImports.push(...findComputedDynamicImports(rel, src));
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
  return { reachable, computedImports };
}

function deriveRequired() {
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

  const graphEntries = ['bin/antigravity.mjs', ...commandModules, ...mcpModules];
  const { reachable, computedImports } = walkImportGraph(graphEntries);
  for (const rel of reachable) {
    add(required, rel, 'reachable from bin/antigravity.mjs, a command module, or an MCP server');
  }

  return { required, computedImports };
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

export {
  NAMED_COMPUTED_IMPORTS,
  findComputedDynamicImports,
  maskCommentsAndStrings,
  unnamedComputedImports,
};

function runCli() {
  const { required, computedImports } = deriveRequired();

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
      `scripts/commands/*.mjs, scripts/mcp/*.mjs, and the import graph`,
  );

  const missingRequired = [];
  for (const [relPath, why] of required) {
    if (!files.has(relPath)) missingRequired.push({ path: relPath, why });
  }

  const unnamedComputed = unnamedComputedImports(computedImports, [...required.keys()]);

  if (missingRequired.length > 0) {
    console.error('missing required pack entries:');
    for (const item of missingRequired) {
      console.error(`  ${item.path} — ${item.why}`);
    }
  }

  if (unnamedComputed.length > 0) {
    console.error('computed dynamic import (specifier is not a literal); name the target:');
    for (const hit of unnamedComputed) {
      console.error(
        `  ${hit.file}:${hit.line} — a maintainer must name the target ` +
          `(or it must already be required by an explicit rule)`,
      );
    }
  }

  if (missingRequired.length > 0 || unnamedComputed.length > 0) {
    process.exit(1);
  }

  console.log('ok: required pack entries for Claude Code, Codex CLI, agy, and standalone are present');
}

if (isMainModule()) runCli();
