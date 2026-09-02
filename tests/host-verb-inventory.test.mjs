/**
 * Fail if the public verb set drifts across host discovery surfaces.
 *
 * Each surface's set is derived from the file (dispatcher array, directory
 * listing, YAML command names, SKILL.md verb table) and compared against
 * the frozen 1.x contract in docs/COMPATIBILITY.md — not against each
 * other. Deriving "expected" from a union of the same surfaces under test
 * would let all of them drift together in lockstep and still pass; only an
 * independent oracle catches that. A ninth verb added in one place and
 * forgotten in another names the exact neglected surface.
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

/**
 * Named surfaces, read once at module scope — each becomes its own `it`
 * below. A ninth verb added in one place and forgotten in another names the
 * exact neglected surface instead of a single "some surface failed" case.
 */
const SURFACES = [
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

/**
 * The frozen 1.x public command surface, copied verbatim from
 * docs/COMPATIBILITY.md ("The public verbs are exactly: ..."). This is the
 * independent oracle (TotT R19): it comes from the contract document, never
 * from reading any of the surfaces under test.
 */
const EXPECTED_VERBS = uniqueSorted([
  'setup',
  'review',
  'rescue',
  'task',
  'vision',
  'status',
  'result',
  'cancel',
]);

describe('host verb inventory', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} matches the frozen 1.x verb set exactly, with no gaps or extras`, () => {
      assert.deepEqual(uniqueSorted(surface.verbs), EXPECTED_VERBS, `${surface.name} does not match docs/COMPATIBILITY.md`);
    });

    it(`${surface.name} lists each verb exactly once, with no duplicates`, () => {
      const dupes = uniqueSorted(surface.verbs.filter((verb, i) => surface.verbs.indexOf(verb) !== i));
      assert.deepEqual(dupes, [], `${surface.name} lists duplicates: ${dupes.join(', ')}`);
    });
  }
});
