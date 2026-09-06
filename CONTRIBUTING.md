# Contributing

Open an issue before you propose a behavior change.

## Gates

Every pull request runs these five gates on Ubuntu and Windows, with Node 22.3 and Node 24 (the lint gate runs on the Node 24 job only):

```bash
npm run lint
node --test --experimental-test-module-mocks tests/*.test.mjs
node scripts/check-manifests.mjs
node scripts/check-pack.mjs
node scripts/bump-version.mjs --check
```

## The 1.x contract

The eight verbs, their flags, exit codes, `--json` envelope, and state locations are frozen for 1.x. Read [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) before you propose a change to any of them; a breaking change needs a 2.0.0 release.

## Branches and releases

Work lands on `main` through a pull request. Releases follow [docs/RELEASING.md](./docs/RELEASING.md): trusted publishing, signed tags, and verification.

## Docs travel with the change

A change that alters behavior, output, flags, or state updates `CHANGELOG.md` and the relevant file under `docs/` in the same pull request. A pull request that changes behavior without its docs is incomplete.

## Scope

This repository ships a product: the plugin's code, tests, and docs. Pull requests stay in that scope. A maintainer's internal notes, vault, or agent orchestration tooling never belong here.
