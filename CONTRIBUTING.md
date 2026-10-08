# Contributing

Open an issue before you propose a behavior change.

## Gates

Every pull request runs these five gates on Ubuntu, Windows, and macOS, with Node 22.3.x and Node 24 (the lint gate runs on the Node 24 jobs only):

```bash
npm run lint
node --test --experimental-test-module-mocks tests/*.test.mjs
node scripts/check-manifests.mjs
node scripts/check-pack.mjs
node scripts/bump-version.mjs --check
```

`bump-version.mjs --check` also fails, naming the file and line, when a
tracked markdown file other than `CLAUDE.md` or `AGENTS.md` still names an
internal planning identifier: the word "plan", one space, then three digits,
case-sensitive (the word "planning" does not match). Before a release, run
`git grep -n -E "plan [0-9]{3}" -- '*.md' ':!CLAUDE.md' ':!AGENTS.md'` and
remove every hit, or replace it with a user-facing explanation, so this gate
passes.

## The 3.x contract

The nine verbs, their flags, exit codes, `--json` envelope, and state locations are frozen for 3.x. Read [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) before you propose a change to any of them; a breaking change needs a 4.0.0 release.

## Branches and releases

Work lands on `main` through a pull request. Releases follow [docs/RELEASING.md](./docs/RELEASING.md): trusted publishing, signed tags, and verification.

## Docs travel with the change

A change that alters behavior, output, flags, or state updates `CHANGELOG.md` and the relevant file under `docs/` in the same pull request. A pull request that changes behavior without its docs is incomplete.

## Scope

This repository ships a product: the plugin's code, tests, and docs. Pull requests stay in that scope. A maintainer's internal notes, vault, or agent orchestration tooling never belong here.
