# Releasing

This runbook is for the maintainer of `@southcarpet/antigravity-plugin`.

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

## One-time npmjs.com setup

The package owner does this once in the browser. Open the package page for
`@southcarpet/antigravity-plugin`. Select Settings, then Trusted Publisher,
then GitHub Actions. Enter these values:

| Field | Value |
|---|---|
| Organization or user | `southcarpet` |
| Repository | `antigravity-plugin` |
| Workflow filename | `release.yml` |
| Environment name | leave blank |
| Allowed action | `npm publish` |

The filename must match the file under `.github/workflows/` exactly. Until
you configure this publisher, the Publish step fails with an authentication
error. Nothing is published.

## Release flow

1. Start from the commit that you will release. Write the release notes under
   `## [Unreleased]` in `CHANGELOG.md`.
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
5. Tag with a signature. See [Tag signing](#tag-signing).
   `git tag -s vX.Y.Z -m "vX.Y.Z"`, then `git tag -v vX.Y.Z`.
6. Push the commit first. Then push the tag:
   `git push origin main` and `git push origin vX.Y.Z`.
   CI runs on the commit; the tag push starts `release.yml`.
7. Watch the run on the Actions tab or use `gh run watch`. The job stops
   before publishing when a gate fails, when the tag does not match
   `package.json`, or when npmjs.com does not trust the workflow yet.
8. Verify the published version (next section).

## Tag signing

Release tags use the maintainer's existing SSH key. Git supports SSH signing
from version 2.34. You do not need GPG setup. If no key exists, create one:
`ssh-keygen -t ed25519 -C "<e-mail>"`. Configure the maintainer's machine
once:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub   # the public half of the existing key
git config --global tag.gpgsign true                         # sign every annotated tag
```

With `tag.gpgsign true`, `git tag -a vX.Y.Z -m "vX.Y.Z"` signs the tag;
`git tag -s` does the same explicitly. `git tag -v` needs an allowed-signers
file that maps the maintainer's e-mail to the public key:

```bash
printf '%s %s\n' "$(git config user.email)" "$(cut -d' ' -f1,2 ~/.ssh/id_ed25519.pub)" \
  > ~/.ssh/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers
git tag -v vX.Y.Z
```

On Windows, Git for Windows ships an MSYS `ssh-keygen`. Measured on
2026-09-02, it cannot reach the Windows `ssh-agent` service. Therefore,
`git tag -a` prompts for the passphrase and fails in a non-interactive shell
even when the key is loaded. Run `git config --global gpg.ssh.program
C:\Windows\System32\OpenSSH\ssh-keygen.exe`, then use `ssh-add` to add the key
to the running `ssh-agent` service once per boot.

The expected result reads `Good "git" signature for <e-mail> with ED25519 key
SHA256:...`. A reader verifies the same way after putting that one line into
their allowed-signers file. The public key is served at
`https://github.com/SouthCarpet.keys`. When the same key is registered on
GitHub as a signing key, GitHub also marks the tag as verified.

Tags `v1.0.0` and `v1.0.1` are not signed. Signing starts at `v1.1.0`.
Provenance (above) names the commit the tarball was built from; the signed
tag proves the maintainer's key vouched for that commit. Together they let a
reader tie the npm tarball to a commit the maintainer signed.

## Verify a published release

```bash
npm view @southcarpet/antigravity-plugin@X.Y.Z dist.attestations
```

Verify that this prints the attestations URL and the provenance count.
Versions before 1.1.0 have no `dist.attestations` field at all.

```bash
mkdir verify && cd verify
npm init -y >/dev/null
npm install @southcarpet/antigravity-plugin@X.Y.Z
npm audit signatures
```

Verify that `npm audit signatures` reports the package as having a verified
registry signature and a verified attestation.

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

Provenance does not review the code. It does not show that the code is correct
or safe. It does not cover `agy` or Google's services. It cannot protect
against a compromised GitHub account that can push a tag. npm generates an
attestation only for an OIDC publish from a public repository. You cannot
produce one on a laptop.
