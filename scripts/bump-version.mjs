#!/usr/bin/env node
/**
 * Bump or verify the seven host-facing version scalars together.
 *
 * Detector: scripts/check-manifests.mjs (fails on drift).
 * This script is the writer, plus CHANGELOG heading/compare-link
 * agreement, the README Status blockquote version, and a read-only
 * git-tag report. It never creates, moves, or deletes tags.
 *
 * Seven scalars (six files; marketplace.json carries two):
 *   package.json                               .version
 *   plugin.json                                .version
 *   .claude-plugin/plugin.json                 .version
 *   .codex-plugin/plugin.json                  .version
 *   .claude-plugin/marketplace.json            .metadata.version
 *   .claude-plugin/marketplace.json            .plugins[0].version
 *   .agents/plugins/marketplace.json           .metadata.version
 */
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } = fs;

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Strict semver: no leading zeros, optional prerelease/build. Rejects `v1.0.0`, `1.0`, `01.0.0`. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const INCREMENTS = new Set(['patch', 'minor', 'major']);

const PLUGIN_COPIES = [
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
];

const COMPARE_REPO = 'https://github.com/SouthCarpet/antigravity-plugin';

/**
 * @typedef {{ label: string, file: string, get: (json: any) => unknown, set: (json: any, version: string) => void }} Scalar
 */

/** @type {Scalar[]} */
const SCALARS = [
  {
    label: 'package.json version',
    file: 'package.json',
    get: (j) => j.version,
    set: (j, v) => {
      j.version = v;
    },
  },
  {
    label: 'plugin.json version',
    file: 'plugin.json',
    get: (j) => j.version,
    set: (j, v) => {
      j.version = v;
    },
  },
  {
    label: '.claude-plugin/plugin.json version',
    file: '.claude-plugin/plugin.json',
    get: (j) => j.version,
    set: (j, v) => {
      j.version = v;
    },
  },
  {
    label: '.codex-plugin/plugin.json version',
    file: '.codex-plugin/plugin.json',
    get: (j) => j.version,
    set: (j, v) => {
      j.version = v;
    },
  },
  {
    label: '.claude-plugin/marketplace.json metadata.version',
    file: '.claude-plugin/marketplace.json',
    get: (j) => j.metadata?.version,
    set: (j, v) => {
      if (!j.metadata || typeof j.metadata !== 'object' || Array.isArray(j.metadata)) {
        throw new Error('.claude-plugin/marketplace.json metadata is missing');
      }
      j.metadata.version = v;
    },
  },
  {
    label: '.claude-plugin/marketplace.json plugins[0].version',
    file: '.claude-plugin/marketplace.json',
    get: (j) => j.plugins?.[0]?.version,
    set: (j, v) => {
      if (!j.plugins?.[0] || typeof j.plugins[0] !== 'object') {
        throw new Error('.claude-plugin/marketplace.json plugins[0] is missing');
      }
      j.plugins[0].version = v;
    },
  },
  {
    label: '.agents/plugins/marketplace.json metadata.version',
    file: '.agents/plugins/marketplace.json',
    get: (j) => j.metadata?.version,
    set: (j, v) => {
      if (!j.metadata || typeof j.metadata !== 'object' || Array.isArray(j.metadata)) {
        throw new Error('.agents/plugins/marketplace.json metadata is missing');
      }
      j.metadata.version = v;
    },
  },
];

function usage() {
  return [
    'Usage:',
    '  node scripts/bump-version.mjs <patch|minor|major|x.y.z>',
    '  node scripts/bump-version.mjs --check [x.y.z]',
    '',
    'Options:',
    '  --check, --dry-run  Verify version, CHANGELOG, README Status, and tag agreement; write nothing.',
    '  --root <dir>        Operate on a different tree (tests). Default: this repo.',
    '  --help, -h          Print this help.',
    '',
    'Does not create, move, or delete git tags.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: defaultRoot,
    target: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--dry-run') {
      options.check = true;
    } else if (arg === '--root') {
      const root = argv[i + 1];
      if (!root) throw new Error('--root requires a directory.\n\n' + usage());
      options.root = root;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else if (options.target) {
      throw new Error(`Unexpected extra argument: ${arg}\n\n${usage()}`);
    } else {
      options.target = arg;
    }
  }

  return options;
}

function isSemver(version) {
  return typeof version === 'string' && SEMVER.test(version);
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function incrementVersion(current, kind) {
  const match = current.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/);
  if (!match) {
    throw new Error(`Cannot increment ${kind} from non-semver version: ${current}`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

function readBuf(root, rel) {
  return readFileSync(join(root, rel));
}

function readJson(root, rel) {
  return JSON.parse(readBuf(root, rel).toString('utf8'));
}

function jsonText(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readScalars(root) {
  /** @type {{ label: string, file: string, value: string }[]} */
  const values = [];
  const errors = [];
  for (const scalar of SCALARS) {
    try {
      const json = readJson(root, scalar.file);
      const value = scalar.get(json);
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`${scalar.label}: missing or empty`);
        continue;
      }
      values.push({ label: scalar.label, file: scalar.file, value });
    } catch (err) {
      errors.push(`${scalar.label}: unreadable (${err.message})`);
    }
  }
  return { values, errors };
}

function pluginCopyErrors(root) {
  const errors = [];
  const bodies = [];
  for (const rel of PLUGIN_COPIES) {
    try {
      bodies.push({ rel, buf: readBuf(root, rel) });
    } catch (err) {
      errors.push(`${rel}: unreadable (${err.message})`);
    }
  }
  if (bodies.length === PLUGIN_COPIES.length) {
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
  return errors;
}

function changelogHeadingRe(version) {
  return new RegExp(`^## \\[${escapeRe(version)}\\](?:\\s+[—-].*)?\\s*$`, 'm');
}

/** README Status blockquote: `> **Pre-release (vX.Y.Z).**` */
const README_STATUS_RE = /^> \*\*Pre-release \(v([^)]+)\)\.\*\*/m;

function readmeStatusErrors(root, version) {
  let text;
  try {
    text = readBuf(root, 'README.md').toString('utf8');
  } catch (err) {
    return [`README.md: unreadable (${err.message})`];
  }
  const match = text.match(README_STATUS_RE);
  if (!match) {
    return ['README.md: missing Status blockquote **Pre-release (vX.Y.Z).**'];
  }
  if (match[1] !== version) {
    return [`README.md Status: v${match[1]} (expected v${version})`];
  }
  return [];
}

function applyReadmeStatus(text, version) {
  if (!README_STATUS_RE.test(text)) {
    throw new Error('README.md: missing Status blockquote **Pre-release (vX.Y.Z).**');
  }
  return text.replace(README_STATUS_RE, `> **Pre-release (v${version}).**`);
}

function changelogErrors(root, version) {
  const errors = [];
  let text;
  try {
    text = readBuf(root, 'CHANGELOG.md').toString('utf8');
  } catch (err) {
    return [`CHANGELOG.md: unreadable (${err.message})`];
  }

  if (!changelogHeadingRe(version).test(text)) {
    errors.push(`CHANGELOG.md: missing heading ## [${version}]`);
  }

  const unreleasedLink = text.match(/^\[Unreleased\]:\s+(\S+)/m);
  if (!unreleasedLink) {
    errors.push('CHANGELOG.md: missing [Unreleased] compare link');
  } else {
    const expected = `${COMPARE_REPO}/compare/v${version}...HEAD`;
    if (unreleasedLink[1] !== expected) {
      errors.push(
        `CHANGELOG.md [Unreleased] compare link: ${unreleasedLink[1]} (expected ${expected})`,
      );
    }
  }

  const versionLink = text.match(new RegExp(`^\\[${escapeRe(version)}\\]:\\s+(\\S+)`, 'm'));
  if (!versionLink) {
    errors.push(`CHANGELOG.md: missing [${version}] compare/release link`);
  }

  return errors;
}

/**
 * Report tag presence. Never fail --check solely because the tag is
 * missing: tagging is the maintainer's act, and CI checkouts often
 * have no tags. Do not walk up into a parent git repo.
 */
function tagReport(root, version) {
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir)) {
    return `note: ${root} is not a git repository; not checking tags`;
  }
  const result = spawnSync('git', ['tag', '--list', `v${version}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return `note: could not list git tags (${detail || `exit ${result.status}`})`;
  }
  const tags = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (tags.includes(`v${version}`)) {
    return `ok: git tag v${version} exists`;
  }
  return `note: git tag v${version} is absent (this script does not create, move, or delete tags)`;
}

function checkAgreement(root, expectedVersion) {
  const errors = [];
  const { values, errors: readErrors } = readScalars(root);
  errors.push(...readErrors);
  for (const { label, value } of values) {
    if (value !== expectedVersion) {
      errors.push(`${label}: ${value} (expected ${expectedVersion})`);
    }
  }
  errors.push(...pluginCopyErrors(root));
  errors.push(...changelogErrors(root, expectedVersion));
  errors.push(...readmeStatusErrors(root, expectedVersion));
  return { errors, values };
}

function unreleasedHasNotes(body) {
  return /^(#{2,3}\s|[-*+]\s|\d+\.\s)/m.test(body);
}

function previousFromChangelog(text, fallback) {
  const match = text.match(/^\[Unreleased\]:\s+\S+\/compare\/v([^/\s]+)\.\.\.HEAD/m);
  return match ? match[1] : fallback;
}

function updateCompareLinks(text, newVersion, previousVersion) {
  let out = text;
  const unreleasedLine = `[Unreleased]: ${COMPARE_REPO}/compare/v${newVersion}...HEAD`;
  if (/^\[Unreleased\]:\s+\S+/m.test(out)) {
    out = out.replace(/^\[Unreleased\]:\s+\S+/m, unreleasedLine);
  } else {
    out = `${out.replace(/\s*$/, '')}\n\n${unreleasedLine}\n`;
  }

  if (newVersion !== previousVersion) {
    const newLink = `[${newVersion}]: ${COMPARE_REPO}/compare/v${previousVersion}...v${newVersion}`;
    const newLinkRe = new RegExp(`^\\[${escapeRe(newVersion)}\\]:\\s+\\S+`, 'm');
    if (newLinkRe.test(out)) {
      out = out.replace(newLinkRe, newLink);
    } else {
      out = out.replace(/^(\[Unreleased\]:[^\n]+)/m, `$1\n${newLink}`);
    }
  }
  return out;
}

function applyChangelog(text, newVersion, previousVersion, date) {
  if (!/^## \[Unreleased\][ \t]*$/m.test(text)) {
    throw new Error('CHANGELOG.md: missing ## [Unreleased] heading');
  }

  if (changelogHeadingRe(newVersion).test(text)) {
    return updateCompareLinks(text, newVersion, previousVersion);
  }

  const unreleasedIdx = text.search(/^## \[Unreleased\][ \t]*$/m);
  const afterHeading = text.indexOf('\n', unreleasedIdx);
  if (afterHeading === -1) {
    throw new Error('CHANGELOG.md: ## [Unreleased] is the last line and has no notes');
  }
  const rest = text.slice(afterHeading + 1);
  const nextRel = rest.search(/^## \[/m);
  const body = nextRel === -1 ? rest : rest.slice(0, nextRel);
  if (!unreleasedHasNotes(body)) {
    throw new Error(
      `CHANGELOG.md [Unreleased] has no notes to promote into ## [${newVersion}]; ` +
        `write the release notes first (or add the heading yourself)`,
    );
  }

  const trimmedBody = body.replace(/^\r?\n+/, '').replace(/\s*$/, '\n\n');
  const prefix = text.slice(0, afterHeading + 1);
  const suffix = nextRel === -1 ? '' : rest.slice(nextRel);
  const rebuilt = `${prefix}\n## [${newVersion}] — ${date}\n\n${trimmedBody}${suffix}`;
  return updateCompareLinks(rebuilt, newVersion, previousVersion);
}

function stagingPath(absPath) {
  return `${absPath}.${process.pid}.tmp`;
}

function unlinkIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

/**
 * Two-phase write of every planned file.
 *
 * Phase 1 (staging): write each payload to `<target>.<pid>.tmp` beside
 * the target. If any staging write fails, delete temps already created
 * and throw — the original files are byte-identical to how we found them.
 *
 * Phase 2 (commit): rename each temp onto its target. On Windows, rename
 * cannot replace an existing file, so the fallback is copy + unlink.
 *
 * Residue: the commit loop is not a single filesystem transaction. If a
 * later rename/copy fails, earlier targets already hold the new content.
 * POSIX rename is atomic per file; the set of files is not, and Windows
 * has no atomic replace. That window is narrow (every byte is already on
 * disk from a successful staging phase) and retrying the same bump is
 * the recovery. This script does not claim all-or-none past staging.
 */
function stageAll(root, planned) {
  /** @type {{ rel: string, abs: string, tmp: string }[]} */
  const staged = [];
  try {
    for (const { rel, contents } of planned) {
      const abs = join(root, rel);
      const tmp = stagingPath(abs);
      try {
        writeFileSync(tmp, contents);
      } catch (err) {
        try {
          unlinkIfExists(tmp);
        } catch {
          // best-effort: still surface the write error
        }
        throw err;
      }
      const written = readFileSync(tmp);
      const expected = Buffer.from(contents);
      if (Buffer.compare(written, expected) !== 0) {
        throw new Error(`staged content mismatch for ${rel}`);
      }
      staged.push({ rel, abs, tmp });
    }
  } catch (err) {
    for (const { tmp } of staged) {
      try {
        unlinkIfExists(tmp);
      } catch {
        // best-effort cleanup; the original targets were not touched
      }
    }
    throw new Error(
      `${err.message}\n\n` +
        `bump failed while staging replacement files. No target files were replaced.`,
    );
  }
  return staged;
}

function commitStaged(staged) {
  const committed = [];
  try {
    for (const { rel, abs, tmp } of staged) {
      try {
        renameSync(tmp, abs);
      } catch {
        try {
          copyFileSync(tmp, abs);
          unlinkIfExists(tmp);
        } catch (err) {
          throw new Error(
            `failed replacing ${abs}: ${err.message} (temp file may remain at ${tmp})`,
          );
        }
      }
      committed.push(rel);
    }
  } catch (err) {
    const remaining = staged.filter((s) => !committed.includes(s.rel));
    throw new Error(
      `${err.message}\n\n` +
        `bump failed while committing staged files. Staging had succeeded; ` +
        `this is the remaining non-atomic window (see writeAll).\n` +
        `Already committed:\n  ${committed.length > 0 ? committed.join('\n  ') : '(none)'}\n` +
        `Not committed:\n  ${remaining.length > 0 ? remaining.map((s) => s.rel).join('\n  ') : '(none)'}`,
    );
  }
  return committed;
}

function writeAll(root, planned) {
  const staged = stageAll(root, planned);
  return commitStaged(staged);
}

function prepareWrites(root, version, previousVersion) {
  /** @type {{ rel: string, contents: string }[]} */
  const planned = [];
  const changelogText = readBuf(root, 'CHANGELOG.md').toString('utf8');
  const nextChangelog = applyChangelog(changelogText, version, previousVersion, utcDate());
  planned.push({ rel: 'CHANGELOG.md', contents: nextChangelog });
  const readmeText = readBuf(root, 'README.md').toString('utf8');
  planned.push({ rel: 'README.md', contents: applyReadmeStatus(readmeText, version) });

  const uniqueFiles = [...new Set(SCALARS.map((s) => s.file))];
  /** @type {Map<string, any>} */
  const parsed = new Map();
  for (const file of uniqueFiles) {
    parsed.set(file, readJson(root, file));
  }
  for (const scalar of SCALARS) {
    scalar.set(parsed.get(scalar.file), version);
  }

  const pluginBody = jsonText(parsed.get('plugin.json'));
  for (const rel of PLUGIN_COPIES) {
    planned.push({ rel, contents: pluginBody });
  }

  for (const file of uniqueFiles) {
    if (PLUGIN_COPIES.includes(file)) continue;
    planned.push({ rel: file, contents: jsonText(parsed.get(file)) });
  }

  return planned;
}

function printCheck(root, expectedVersion) {
  const { errors, values } = checkAgreement(root, expectedVersion);
  const tagLine = tagReport(root, expectedVersion);

  if (errors.length > 0) {
    console.error('version check failed:');
    for (const line of errors) console.error(`  ${line}`);
    console.error(`  ${tagLine}`);
    process.exitCode = 1;
    return;
  }

  console.log(`ok: ${values.length} version scalars agree on ${expectedVersion}`);
  for (const { label, value } of values) {
    console.log(`  ${label} = ${value}`);
  }
  console.log(`ok: ${PLUGIN_COPIES.join(', ')} are byte-identical`);
  console.log(`ok: CHANGELOG.md has ## [${expectedVersion}] and matching compare links`);
  console.log(`ok: README.md Status is Pre-release (v${expectedVersion})`);
  console.log(tagLine);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const root = options.root;

  if (options.check) {
    let expected;
    if (options.target) {
      if (!isSemver(options.target)) {
        throw new Error(
          `Invalid version ${JSON.stringify(options.target)}. ` +
            `Expected strict semver (e.g. 1.2.3), not an increment, in --check.\n\n${usage()}`,
        );
      }
      expected = options.target;
    } else {
      const pkg = readJson(root, 'package.json');
      if (!isSemver(pkg.version)) {
        throw new Error(
          `package.json version ${JSON.stringify(pkg.version)} is not strict semver`,
        );
      }
      expected = pkg.version;
    }
    printCheck(root, expected);
    return;
  }

  if (!options.target) {
    throw new Error(`Missing version or increment.\n\n${usage()}`);
  }

  const pkg = readJson(root, 'package.json');
  const current = pkg.version;
  if (typeof current !== 'string' || !isSemver(current)) {
    throw new Error(`package.json version ${JSON.stringify(current)} is not strict semver`);
  }

  let next;
  if (INCREMENTS.has(options.target)) {
    const { values, errors } = readScalars(root);
    if (errors.length > 0 || values.some((v) => v.value !== current)) {
      const drift = [
        ...errors,
        ...values.filter((v) => v.value !== current).map((v) => `${v.label}: ${v.value} (expected ${current})`),
      ];
      throw new Error(
        `Refusing to apply ${options.target}: version scalars already drift. ` +
          `Pass an explicit target version to repair.\n` +
          drift.map((line) => `  ${line}`).join('\n'),
      );
    }
    next = incrementVersion(current, options.target);
  } else if (isSemver(options.target)) {
    next = options.target;
  } else {
    throw new Error(
      `Invalid version ${JSON.stringify(options.target)}. ` +
        `Expected patch, minor, major, or strict semver (e.g. 1.2.3).\n\n${usage()}`,
    );
  }

  if (next === current && INCREMENTS.has(options.target)) {
    throw new Error(`Refusing no-op increment: already at ${current}`);
  }

  const changelogText = readBuf(root, 'CHANGELOG.md').toString('utf8');
  const previous = previousFromChangelog(changelogText, current);
  const planned = prepareWrites(root, next, previous);
  const written = writeAll(root, planned);

  console.log(`Set version metadata to ${next}`);
  console.log(`Updated: ${written.join(', ')}`);
  const { errors } = checkAgreement(root, next);
  if (errors.length > 0) {
    throw new Error(
      `Wrote files but the tree still disagrees:\n${errors.map((e) => `  ${e}`).join('\n')}`,
    );
  }
  console.log(`ok: ${SCALARS.length} version scalars agree on ${next}`);
  console.log(`ok: ${PLUGIN_COPIES.join(', ')} are byte-identical`);
  console.log(tagReport(root, next));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
