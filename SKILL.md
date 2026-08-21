---
name: antigravity
description: Use Google Antigravity CLI (agy) for code review, adversarial review, debugging, long-running task delegation, or large-context investigation. Hands off to agy's large-context window when the host wants a second opinion or a background pass instead of solving the task file-by-file. Survives the June 18, 2026 gemini-cli sunset by depending only on the agy binary.
allowed-tools: Bash, Glob, Read
---

# antigravity — when to use the `$antigravity` shortcut

Reach for `$antigravity` when any of these apply:

- You want a **second opinion** on a non-trivial diff, refactor, or design choice.
- The task benefits from a **large context window** (cross-file review, repo-wide impact analysis, long log triage).
- You want to **delegate a long-running task to the background** so the host session can keep working — e.g. "investigate why CI started failing on main" or "draft a migration plan for switching from X to Y".
- You want an **adversarial review** of code that's about to ship.

Skip `$antigravity` for trivial one-line edits or anything that requires interactive back-and-forth tighter than agy's `--print` round trips.

## Verbs

All verbs map to the same `scripts/commands/<verb>.mjs` runtime across Claude Code (`/antigravity:<verb>`), Codex CLI (`$antigravity <verb>`), agy native (`agy plugin run antigravity <verb>`), and standalone (`npx @southcarpet/antigravity-plugin <verb>`, or `node bin/antigravity.mjs <verb>` from a clone). Host wrappers differ in shape; the verb set and flag contract do not.

| Verb     | What it does |
|----------|--------------|
| `setup`  | One-time OAuth wizard. Runs an authenticated `agy --print` probe in the foreground so the user can complete the Google OAuth flow visibly. Idempotent. Also registers the vision MCP server (`--skip-vision` to opt out, `--remove-vision` to undo plugin-owned entries). Foreground-only. |
| `review` | Reviews the current git diff (or `--base <ref>`). Foreground by default; pass `--background` to fork a worker and get a job id. |
| `rescue` | Delegates an investigation or fix to agy — e.g. `$antigravity rescue why are the tests failing`. Foreground by default; `--background` returns a job id. |
| `task`   | Generic long-running delegation. Background by default; `--foreground` to inline, `--wait` to block. Supports `--continue`, `--conversation <id>`, `--add-dir <path>`, `--json`. |
| `vision` | Ask agy to look at one or more image files (`--prompt`, `--model`, `--json`). Foreground-only; needs the vision MCP server registered by `setup` (see Auth requirements below). |
| `status` | Shows a compact table of current and recent jobs (id, kind, phase, health, last progress). Surfaces any pending OAuth URL prominently. |
| `result` | Prints the final output of a completed job by id. |
| `cancel` | Sends SIGTERM to a running worker by job id. |

## Auth requirements

agy 1.0.x is **OAuth-only** — there is no API-key path yet (tracked upstream as `antigravity-cli#78`).

1. Run `$antigravity setup` (or `/antigravity:setup` from Claude Code) once per machine / account.
2. agy prints an OAuth URL — open it in a browser, complete the Google flow.
3. agy persists the refresh token in its own credential store. Subsequent invocations of any verb run silently.

If a background worker hits the auth prompt (e.g. a fresh machine), it captures the OAuth URL and surfaces it on `$antigravity status <job-id>` so you can still complete auth from a non-interactive session.

`setup` also registers the **vision MCP server + exact permission** `$antigravity vision` needs — `agy --print` has no native image ingestion path, so image questions only get real visual answers once `setup` has written `~/.gemini/config/mcp_config.json` (`mcpServers.vision`) and `~/.gemini/antigravity-cli/settings.json` (`permissions.allow` including only `mcp(vision/view_image)`). Each vision run confines the server to the user-named paths. Pass `setup --skip-vision` to opt out or `setup --remove-vision` to remove only plugin-owned entries.

## Example prompts

```
$antigravity review --base main
$antigravity rescue investigate why the integration tests started failing after PR #42
$antigravity task --continue draft a migration plan from Sequelize to Drizzle
$antigravity vision ./screenshot.png --prompt "does this chart render the values 3, 5, 8?"
$antigravity status
$antigravity result 0193e2c9-...
```

## Where this plugin lives (for Codex auto-discovery)

Codex picks this plugin up via:

- `.codex-plugin/plugin.json` — canonical Codex manifest.
- `.agents/plugins/marketplace.json` — Codex personal-marketplace descriptor.
- This `SKILL.md` at the plugin install root — skill-discovery entry.
- `agents/openai.yaml` — implicit-invocation interface (the `$antigravity` shortcut).

Claude Code, agy, and standalone hosts ignore the Codex-specific files and consume `.claude-plugin/`, `plugin.json` (root), and `bin/antigravity.mjs` respectively. See [docs/INSTALL.md](./docs/INSTALL.md) for per-host install recipes.
