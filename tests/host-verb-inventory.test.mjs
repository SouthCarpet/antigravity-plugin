/**
 * Fail if the public verb set drifts across host discovery surfaces.
 *
 * Each surface's set is derived from the file (dispatcher array, directory
 * listing, YAML command names, SKILL.md verb table). Marketplace JSON
 * files are catalogs, not verb enumerations, and are not surfaces.
 * There is no hardcoded expected verb list: a ninth verb added in one
 * place and forgotten in another grows the union and the neglected
 * surface is named.
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

function verbsFromSkillMd(source) {
  const headingRe = /^## Verbs\s*$/m;
  const headingMatch = headingRe.exec(source);
  if (!headingMatch) {
    throw new Error('SKILL.md: could not find ## Verbs heading');
  }

  const afterHeading = source.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = afterHeading.search(/^## /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const lines = section.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*Verb\s*\|/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('SKILL.md: ## Verbs section has no markdown table with a Verb column');
  }

  const separator = lines[headerIdx + 1] ?? '';
  if (!/^\|[\s:|-]+\|$/.test(separator.trim())) {
    throw new Error('SKILL.md: Verb table is missing a markdown separator row');
  }

  const verbs = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    if (!line.startsWith('|')) break;
    const cell = line.match(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/);
    if (!cell) {
      throw new Error(`SKILL.md: Verb table row is not a backticked verb identifier: ${line}`);
    }
    verbs.push(cell[1]);
  }

  if (verbs.length === 0) {
    throw new Error('SKILL.md: Verb table has no verb rows');
  }
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
        name: 'SKILL.md verb table',
        verbs: verbsFromSkillMd(read('SKILL.md')),
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
