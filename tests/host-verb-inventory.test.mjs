/**
 * Fail if the public verb set drifts across host discovery surfaces.
 *
 * Each surface's set is derived from the file (dispatcher array, directory
 * listing, YAML command names, marketplace `commands` arrays). There is no
 * hardcoded expected verb list: a ninth verb added in one place and
 * forgotten in another grows the union and the neglected surface is named.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listVerbsFromDir(rel, ext) {
  const dir = path.join(ROOT, rel);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(ext) && !name.startsWith('_'))
    .map((name) => name.slice(0, -ext.length))
    .sort();
}

function verbsFromKnownDispatcher(source) {
  const match = source.match(/\bconst KNOWN = \[([^\]]*)\]/);
  if (!match) {
    throw new Error("bin/antigravity.mjs: could not find the KNOWN dispatcher list");
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function verbsFromOpenaiYaml(source) {
  const lines = source.split(/\r?\n/);
  const verbs = [];
  let inCommands = false;
  for (const line of lines) {
    if (!inCommands) {
      if (/^commands:\s*$/.test(line)) inCommands = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) break;
    const m = line.match(/^\s+- name:\s+(\S+)\s*$/);
    if (m) verbs.push(m[1]);
  }
  return verbs;
}

function verbsFromMarketplace(json) {
  const verbs = [];
  function walk(node, key) {
    if (key === 'commands' && Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string') verbs.push(item);
        else if (item && typeof item === 'object' && typeof item.name === 'string') {
          verbs.push(item.name);
        }
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  }
  walk(json, null);
  return verbs;
}

function uniqueSorted(list) {
  return [...new Set(list)].sort();
}

describe('host verb inventory', () => {
  it('every discovery surface enumerates the same derived verb set', () => {
    const surfaces = [
      {
        name: 'bin/antigravity.mjs dispatcher',
        verbs: verbsFromKnownDispatcher(read('bin/antigravity.mjs')),
      },
      {
        name: 'scripts/commands/*.mjs',
        verbs: listVerbsFromDir(path.join('scripts', 'commands'), '.mjs'),
      },
      {
        name: 'commands/*.md',
        verbs: listVerbsFromDir('commands', '.md'),
      },
      {
        name: 'agents/openai.yaml',
        verbs: verbsFromOpenaiYaml(read('agents/openai.yaml')),
      },
      {
        name: '.claude-plugin/marketplace.json',
        verbs: verbsFromMarketplace(JSON.parse(read('.claude-plugin/marketplace.json'))),
      },
      {
        name: '.agents/plugins/marketplace.json',
        verbs: verbsFromMarketplace(JSON.parse(read('.agents/plugins/marketplace.json'))),
      },
    ];

    const union = new Set();
    for (const surface of surfaces) {
      for (const verb of surface.verbs) union.add(verb);
    }

    assert.ok(
      union.size > 0,
      'derived verb union is empty — parsers found nothing on any surface',
    );

    const gaps = [];
    for (const surface of surfaces) {
      const have = new Set(surface.verbs);
      const missing = [...union].filter((verb) => !have.has(verb)).sort();
      if (missing.length > 0) {
        gaps.push(`${surface.name} is missing: ${missing.join(', ')}`);
      }
      const dupes = surface.verbs.filter((verb, i) => surface.verbs.indexOf(verb) !== i);
      if (dupes.length > 0) {
        gaps.push(`${surface.name} lists duplicates: ${uniqueSorted(dupes).join(', ')}`);
      }
    }

    assert.equal(
      gaps.length,
      0,
      `host verb inventory mismatch (union=${uniqueSorted(union).join(', ')}):\n  ${gaps.join('\n  ')}`,
    );
  });
});
