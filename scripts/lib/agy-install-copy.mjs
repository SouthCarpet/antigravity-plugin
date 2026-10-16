import fs from 'node:fs';
import path from 'node:path';

export const AGY_VERBS = Object.freeze([
  'cancel', 'doctor', 'rescue', 'result', 'review', 'setup', 'status', 'task', 'vision',
]);

function readIdentity(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  if (pkg?.name !== '@southcarpet/antigravity-plugin' || plugin?.name !== 'antigravity' ||
      pkg.version !== plugin.version || typeof pkg.version !== 'string') {
    throw new Error('agy install copy: foreign or inconsistent package/plugin manifest');
  }
  return pkg.version;
}

function filesUnder(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`agy install copy: symbolic link refused: ${rel}`);
    return entry.isDirectory() ? filesUnder(root, rel) : [rel];
  });
}

function nativeFiles(root) {
  const dir = path.join(root, 'agy-skills');
  const expected = AGY_VERBS.map((verb) => path.join(verb, 'SKILL.md'));
  const actual = filesUnder(dir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('agy install copy: agy-skills must contain exactly the nine public wrappers');
  }
  for (const verb of AGY_VERBS) {
    const source = fs.readFileSync(path.join(dir, verb, 'SKILL.md'), 'utf8');
    const names = [...source.matchAll(/^name: (.+)$/gm)].map((match) => match[1]);
    if (JSON.stringify(names) !== JSON.stringify([`antigravity:${verb}`])) {
      throw new Error(`agy install copy: ${verb} must declare exactly name: antigravity:${verb}`);
    }
  }
  return expected;
}

function existingCopyMatches(source, target, native) {
  const sourceFiles = filesUnder(source);
  const expected = [...sourceFiles, ...native.map((rel) => path.join('skills', rel))].sort();
  if (JSON.stringify(filesUnder(target).sort()) !== JSON.stringify(expected)) return false;
  return expected.every((rel) => {
    const from = rel.startsWith(`skills${path.sep}`)
      ? path.join('agy-skills', rel.slice('skills'.length + 1))
      : rel;
    return fs.readFileSync(path.join(source, from)).equals(fs.readFileSync(path.join(target, rel)));
  });
}

/** Prepare only a fresh extracted package copy. Never alter the source tree. */
export function prepareAgyInstallCopy(extractedDir) {
  const source = path.resolve(extractedDir);
  if (path.basename(source) !== 'package' || fs.lstatSync(source).isSymbolicLink()) {
    throw new Error('agy install copy: expected an extracted package directory');
  }
  const version = readIdentity(source);
  const native = nativeFiles(source);
  if (fs.existsSync(path.join(source, 'skills'))) {
    throw new Error('agy install copy: the source package must not contain a root skills directory');
  }
  const target = path.join(path.dirname(source), 'antigravity');
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || readIdentity(target) !== version ||
        !existingCopyMatches(source, target, native)) {
      throw new Error('agy install copy: existing antigravity copy differs; use a fresh extraction');
    }
    return target;
  }
  filesUnder(source);
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  fs.cpSync(path.join(source, 'agy-skills'), path.join(target, 'skills'), { recursive: true });
  return target;
}
