# Releasing

Runbook for the maintainer of `@southcarpet/antigravity-plugin`.

A release is a tag `vX.Y.Z` pushed to GitHub. `.github/workflows/release.yml`
runs the four gates on that commit and publishes it to npm through npm
trusted publishing: the job presents a GitHub-issued OIDC token, npm mints a
short-lived credential, and npm attaches a provenance attestation to the
tarball. No npm token is stored in the repository, in GitHub secrets, or on
the laptop for this purpose. The job holds `id-token: write` and
`contents: read`, and nothing else.

Requirements the workflow already meets (docs.npmjs.com/trusted-publishers,
read 2026-09-02): npm 11.5.1 or newer, Node 22.14.0 or newer (the job uses
Node 24), `actions/setup-node` with `registry-url`, a public repository and a
public package.

## One-time setup on npmjs.com

Done once by the package owner, in the browser. Open the package page for
`@southcarpet/antigravity-plugin`, then Settings, then Trusted Publisher, and
choose GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `southcarpet` |
| Repository | `antigravity-plugin` |
| Workflow filename | `release.yml` |
| Environment name | leave blank |
| Allowed action | `npm publish` |

The filename must match the file under `.github/workflows/` exactly. Until
this is configured, the Publish step fails with an authentication error and
nothing is published.

## Release flow

1. Write the release notes under `## [Unreleased]` in `CHANGELOG.md`.
   `bump-version` refuses to promote an empty section.
2. Bump every version scalar at once:
   `node scripts/bump-version.mjs <patch|minor|major|x.y.z>`.
   This rewrites the seven host manifests, the changelog heading and compare
   links, and the README status line.
3. Run the gates locally:

   ```bash
   node --test --experimental-test-module-mocks tests/*.test.mjs
   node scripts/check-manifests.mjs
   node scripts/check-pack.mjs
   node scripts/bump-version.mjs --check
   npm publish --dry-run
   ```

4. Commit: `git commit -am "release: X.Y.Z"`.
5. Tag with a signature (see "Tag signing" below):
   `git tag -s vX.Y.Z -m "vX.Y.Z"`, then `git tag -v vX.Y.Z`.
6. Push the commit first, then the tag:
   `git push origin main` and `git push origin vX.Y.Z`.
   CI runs on the commit; the tag push starts `release.yml`.
7. Watch the run on the Actions tab (or `gh run watch`). The job stops
   before publishing when a gate fails, when the tag does not match
   `package.json`, or when npmjs.com does not trust the workflow yet.
8. Verify the published version (next section).

## Verify a published release

```bash
npm view @southcarpet/antigravity-plugin@X.Y.Z dist.attestations
```

Prints the attestations URL and the provenance count. Versions before 1.1.0
have no `dist.attestations` field at all.

```bash
mkdir verify && cd verify
npm init -y >/dev/null
npm install @southcarpet/antigravity-plugin@X.Y.Z
npm audit signatures
```

`npm audit signatures` must report the package as having a verified registry
signature and a verified attestation.

On npmjs.com, the version page shows a Provenance block naming the source
commit and the workflow run. Check that the commit is the tagged one:
`git rev-parse vX.Y.Z^{commit}` must print the same hash, and
`git tag -v vX.Y.Z` must show a good signature by the maintainer's key.

## What the provenance proves, and what it does not

A valid attestation proves that this exact tarball was built and published
by `release.yml` in the public repository `SouthCarpet/antigravity-plugin`,
from the named commit, in the named workflow run. A signed tag on that commit
proves the maintainer's key vouched for that commit. Together they let a
reader tie the tarball on npm to a commit the maintainer signed.

Provenance does not review the code. It says nothing about whether the code
is correct or safe, nothing about `agy` or Google's services, and it cannot
protect against a compromised GitHub account that can push a tag. There is
no way to produce an attestation on a laptop: npm generates one only for an
OIDC publish from a public repository, which is why publishing moved into
the workflow.
