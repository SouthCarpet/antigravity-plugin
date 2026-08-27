# antigravity-plugin

Multi-host plugin that delegates tasks, code review, and image analysis to
Google Antigravity CLI (`agy`). Maintained fork of
sakibsadmanshajib/antigravity-plugin. This repo ships a plugin/skill product;
it does not consume one, so the root skills-scope rule does not apply here.

## Stack

- Node.js >= 22.3.0, ES modules (`"type": "module"`), no runtime dependencies,
  no lockfile.
- Hosts: Claude Code (`.claude-plugin/`, root `plugin.json`), Codex CLI
  (`.codex-plugin/`, `.agents/plugins/marketplace.json`), agy TUI, and
  standalone CLI (`bin/antigravity.mjs`).

## Run / test / build

- Run standalone: `node bin/antigravity.mjs <verb>` (verbs: setup, review,
  rescue, task, vision, status, result, cancel).
- Test: `node --test --experimental-test-module-mocks tests/*.test.mjs`
- Test with coverage: `npm run test:coverage`
- Manifest parity check: `node scripts/check-manifests.mjs`
- Version/changelog check: `node scripts/bump-version.mjs --check`
- Pack check (tarball contents for all hosts): `node scripts/check-pack.mjs`

## App-only rules

- The eight verbs, their flags, exit codes, `--json` envelope, and state
  locations are frozen for 1.x per `docs/COMPATIBILITY.md`. Breaking the
  surface needs a 2.0.0 bump.
- Never touch `SKILL.md`, `plugin.json`, `.claude-plugin/`, `.codex-plugin/`,
  or `.agents/plugins/marketplace.json` casually. These are the product's own
  distribution manifests, not per-project agent scaffolding: `check-pack`
  fails CI if any required host file drops out of the tarball.
- `SKILL.md` at repo root is the plugin's own entry point, not an installed
  copy of a vault-ops skill.
- OAuth-only auth (no API-key path yet, tracked upstream as
  `antigravity-cli#78`).

## Pointers

- `.vault/` — per-project vault-ops content (registry name
  `antigravity-plugin`).
- `docs/INSTALL.md` — per-host install recipes.
- `docs/COMPATIBILITY.md` — frozen 1.x contract.
