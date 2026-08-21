#!/usr/bin/env node
/**
 * Fail if host-facing version scalars drift, or if the three plugin.json
 * copies are not byte-identical.
 *
 * Seven scalars (six files; marketplace.json carries two):
 *   package.json                               .version
 *   plugin.json                                .version
 *   .claude-plugin/plugin.json                 .version
 *   .codex-plugin/plugin.json                  .version
 *   .claude-plugin/marketplace.json            .metadata.version
 *   .claude-plugin/marketplace.json            .plugins[0].version   ← seventh
 *   .agents/plugins/marketplace.json           .metadata.version
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readBuf(rel) {
  return readFileSync(join(root, rel));
}

function readJson(rel) {
  return JSON.parse(readBuf(rel).toString('utf8'));
}

const errors = [];

const scalars = [
  ['package.json version', () => readJson('package.json').version],
  ['plugin.json version', () => readJson('plugin.json').version],
  ['.claude-plugin/plugin.json version', () => readJson('.claude-plugin/plugin.json').version],
  ['.codex-plugin/plugin.json version', () => readJson('.codex-plugin/plugin.json').version],
  [
    '.claude-plugin/marketplace.json metadata.version',
    () => readJson('.claude-plugin/marketplace.json').metadata?.version,
  ],
  [
    '.claude-plugin/marketplace.json plugins[0].version',
    () => readJson('.claude-plugin/marketplace.json').plugins?.[0]?.version,
  ],
  [
    '.agents/plugins/marketplace.json metadata.version',
    () => readJson('.agents/plugins/marketplace.json').metadata?.version,
  ],
];

const values = [];
for (const [label, get] of scalars) {
  let value;
  try {
    value = get();
  } catch (err) {
    errors.push(`${label}: unreadable (${err.message})`);
    continue;
  }
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label}: missing or empty`);
    continue;
  }
  values.push({ label, value });
}

if (values.length > 0) {
  const expected = values[0].value;
  for (const { label, value } of values) {
    if (value !== expected) {
      errors.push(`${label}: ${value} (expected ${expected})`);
    }
  }
}

const pluginCopies = [
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

const bodies = [];
for (const rel of pluginCopies) {
  try {
    bodies.push({ rel, buf: readBuf(rel) });
  } catch (err) {
    errors.push(`${rel}: unreadable (${err.message})`);
  }
}

if (bodies.length === pluginCopies.length) {
  const canonical = bodies[0];
  for (const other of bodies.slice(1)) {
    if (Buffer.compare(canonical.buf, other.buf) !== 0) {
      errors.push(
        `${other.rel} is not byte-identical to ${canonical.rel} ` +
          `(${canonical.buf.length} vs ${other.buf.length} bytes)`,
      );
    }
  }
}

if (errors.length > 0) {
  console.log('manifest check failed:');
  for (const line of errors) {
    console.log(`  ${line}`);
  }
  process.exit(1);
}

if (values.length > 0) {
  const expected = values[0].value;
  console.log(`ok: ${values.length} version scalars agree on ${expected}`);
  for (const { label, value } of values) {
    console.log(`  ${label} = ${value}`);
  }
}
console.log(`ok: ${pluginCopies.join(', ')} are byte-identical`);
