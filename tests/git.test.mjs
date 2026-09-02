/**
 * Tests for scripts/lib/git.mjs — exercises the non-trivial branches
 * (parsing porcelain output, branch comparison, untracked reads, scope
 * dispatch) against temporary real git repos. Each test gets its own
 * fresh repo (via freshRepo()/repoWithFeatureBranch()) instead of sharing
 * one mutable repo across the whole file: a shared repo made every test's
 * outcome depend on exactly the prior tests having run, in order, and
 * left it in the expected branch/file state — a rename test that only
 * passed because an earlier test had already committed b.txt, tests that
 * had to check a branch back out in a `finally` purely so the *next* test
 * would find a clean tree. Isolated repos are slightly more setup per
 * test but each one now stands alone. The repos are tiny and every
 * operation is a `git` builtin, so the suite stays well under the
 * 30-second budget.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { portableTmpRoot, assertNotGitWorkTree } from './helpers/tmp.mjs';
import { canonicalComparePath } from '../scripts/lib/paths.mjs';
import {
  ensureGitRepository,
  getCurrentBranch,
  getHeadSha,
  getWorkingTreeFiles,
  getStagedDiff,
  getUnstagedDiff,
  getWorkingTreeDiff,
  readUntrackedFiles,
  collectWorkingTreeContext,
  buildWorkingTreeSummary,
  buildBranchComparison,
  collectReviewContext,
} from '../scripts/lib/git.mjs';

// Temp root outside any git work tree. A sandbox TMPDIR may point inside
// a git repo, which confounds tests that need an absolutely-not-a-git-repo
// location.
const TMPROOT = portableTmpRoot();
assertNotGitWorkTree(TMPROOT);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'ignore', env: GIT_ENV });
}

const createdDirs = [];

after(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(TMPROOT, prefix));
  createdDirs.push(dir);
  return dir;
}

/** A fresh repo with a single commit (a.txt) on branch `main`. */
function freshRepo() {
  const repo = tmpDir('antigravity-git-');
  sh('git init -q -b main', repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  sh('git add a.txt', repo);
  sh('git commit -q -m initial', repo);
  return repo;
}

/** A fresh repo whose `feature` branch has one extra commit (feat.txt) on top of `main`, HEAD left on `main`. */
function repoWithFeatureBranch() {
  const repo = freshRepo();
  sh('git checkout -q -b feature', repo);
  fs.writeFileSync(path.join(repo, 'feat.txt'), 'feature\n');
  sh('git add feat.txt', repo);
  sh('git commit -q -m feat', repo);
  sh('git checkout -q main', repo);
  return repo;
}

describe('git.ensureGitRepository / getCurrentBranch / getHeadSha', () => {
  it('returns repo root and branch metadata for a real repo', () => {
    const repo = freshRepo();
    const root = ensureGitRepository(repo);
    assert.equal(canonicalComparePath(root), canonicalComparePath(repo));

    const branch = getCurrentBranch(repo);
    assert.equal(branch, 'main');

    const sha = getHeadSha(repo);
    assert.match(sha, /^[0-9a-f]{7,}$/);
  });

  it('getCurrentBranch returns null in detached HEAD state', () => {
    const repo = freshRepo();
    const sha = getHeadSha(repo);
    sh(`git checkout -q --detach ${sha}`, repo);
    assert.equal(getCurrentBranch(repo), null);
  });

  it('getCurrentBranch returns null for a non-repo cwd', () => {
    const tmp = tmpDir('antigravity-nogit-');
    assertNotGitWorkTree(tmp);
    assert.equal(getCurrentBranch(tmp), null);
  });
});

describe('git.getWorkingTreeFiles / diffs', () => {
  it('classifies staged, unstaged, and untracked entries', () => {
    const repo = freshRepo();
    // Modify a.txt (unstaged), add b.txt staged, create c.txt untracked.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello world\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'second\n');
    sh('git add b.txt', repo);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'untracked\n');

    const out = getWorkingTreeFiles(repo);
    assert.ok(out.unstaged.includes('a.txt'), 'a.txt unstaged');
    assert.ok(out.staged.includes('b.txt'), 'b.txt staged');
    assert.ok(out.untracked.includes('c.txt'), 'c.txt untracked');

    assert.ok(getStagedDiff(repo).includes('b.txt'));
    assert.ok(getUnstagedDiff(repo).includes('a.txt'));
    assert.ok(getWorkingTreeDiff(repo).length > 0);
  });

  it('parses a renamed entry (R index status)', () => {
    const repo = freshRepo();
    fs.writeFileSync(path.join(repo, 'b.txt'), 'second\n');
    sh('git add b.txt', repo);
    sh('git commit -q -m add-b', repo);

    sh('git mv b.txt b-renamed.txt', repo);
    const out = getWorkingTreeFiles(repo);
    // git status --porcelain renders renames as "old -> new"; the parser
    // records the full token as a staged entry.
    assert.ok(
      out.staged.some((f) => f.includes('b-renamed.txt')),
      `expected b-renamed.txt in staged, got ${JSON.stringify(out.staged)}`
    );
  });
});

describe('git.readUntrackedFiles', () => {
  it('reads small text files and skips binary files', () => {
    const root = tmpDir('antigravity-untracked-');
    sh('git init -q', root);
    fs.writeFileSync(path.join(root, 'plain.txt'), 'plain text body\n');
    // Binary: NULL byte in first 8 KB
    const bin = Buffer.from([0x48, 0x69, 0x00, 0x21]);
    fs.writeFileSync(path.join(root, 'bin.dat'), bin);

    const results = readUntrackedFiles(root, ['plain.txt', 'bin.dat', 'missing.txt']);
    const byPath = Object.fromEntries(results.map((r) => [r.path, r]));
    assert.equal(byPath['plain.txt'].content.trim(), 'plain text body');
    assert.ok(byPath['bin.dat'].skipped, 'binary file should be skipped');
    assert.ok(
      byPath['missing.txt'].skipped || byPath['missing.txt'].content === undefined,
      'missing file should be skipped'
    );
  });

  it('stops reading once the byte budget is exhausted', () => {
    const root = tmpDir('antigravity-untracked2-');
    fs.writeFileSync(path.join(root, 'big1.txt'), 'A'.repeat(100));
    fs.writeFileSync(path.join(root, 'big2.txt'), 'B'.repeat(100));

    const results = readUntrackedFiles(root, ['big1.txt', 'big2.txt'], { maxBytes: 100 });
    // First file fits; second triggers budget skip.
    const skipped = results.filter((r) => r.skipped);
    assert.ok(skipped.length >= 1);
  });

  it('skips files outside the cwd via realpath check', () => {
    const real = tmpDir('antigravity-real-');
    fs.writeFileSync(path.join(real, 'evil.txt'), 'outside');
    const results = readUntrackedFiles(real, ['evil.txt'], {
      realpathSync: (p) => {
        // Force the path to "resolve" outside cwd.
        if (p.endsWith('evil.txt')) return '/nowhere/evil.txt';
        return p;
      },
    });
    assert.ok(results[0].skipped, 'file claimed outside cwd should be skipped');
  });
});

describe('git.collectWorkingTreeContext / buildWorkingTreeSummary', () => {
  it('assembles a context envelope with summary string', () => {
    const repo = freshRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'newer\n');
    const ctx = collectWorkingTreeContext(repo);
    assert.equal(typeof ctx.summary, 'string');
    assert.ok(ctx.summary.includes('Branch:'));
    assert.equal(ctx.branch, 'main');
  });

  it('renders a detached-HEAD summary from explicit arguments (pure function)', () => {
    const s = buildWorkingTreeSummary(null, 'deadbeef', ['x.js', 'y.js'], ['z.js']);
    assert.match(s, /detached HEAD/);
    assert.match(s, /Untracked files: 1/);
    assert.match(s, /Changed files: 2/);
  });

  it('omits the untracked line when there are no untracked files (pure function)', () => {
    const empty = buildWorkingTreeSummary('main', 'abcdef0', [], []);
    assert.match(empty, /Branch: main/);
    assert.ok(!empty.includes('Untracked files'));
  });
});

describe('git.buildBranchComparison', () => {
  it('builds diff/commits/fileList for branch vs base', () => {
    const repo = repoWithFeatureBranch();
    sh('git checkout -q feature', repo);

    const cmp = buildBranchComparison(repo, 'main');
    assert.ok(cmp.fileList.includes('feat.txt'));
    assert.ok(cmp.diff.includes('feat.txt'));
    assert.match(cmp.summary, /Changed files: 1/);
    assert.match(cmp.summary, /Comparing HEAD to main/);
  });
});

describe('git.collectReviewContext', () => {
  it('rejects invalid scopes', () => {
    const repo = freshRepo();
    assert.throws(() => collectReviewContext(repo, { scope: 'nope' }), /Invalid scope/);
  });

  it('uses branch scope when explicit base is given', () => {
    const repo = repoWithFeatureBranch();
    sh('git checkout -q feature', repo);
    const { scope, context } = collectReviewContext(repo, { scope: 'branch', base: 'main' });
    assert.equal(scope, 'branch');
    assert.ok(context.fileList.length >= 1);
  });

  it('auto scope falls back to branch comparison when working tree is clean', () => {
    const repo = repoWithFeatureBranch();
    sh('git checkout -q feature', repo);
    const { scope } = collectReviewContext(repo, { scope: 'auto' });
    assert.equal(scope, 'branch');
  });

  it('auto scope returns working-tree when there are changes', () => {
    const repo = freshRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const { scope, context } = collectReviewContext(repo, { scope: 'auto' });
    assert.equal(scope, 'working-tree');
    assert.ok(context.summary.length > 0);
  });

  it('defaults to working-tree when no auto and no branch base', () => {
    const repo = freshRepo();
    const { scope } = collectReviewContext(repo, { scope: 'working-tree' });
    assert.equal(scope, 'working-tree');
  });
});
