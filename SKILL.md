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

All verbs map to the same `scripts/commands/<verb>.mjs` runtime across Claude Code (`/antigravity:<verb>`), Codex CLI (`$antigravity <verb>`), agy TUI (`/antigravity:<verb>` after `agy plugin install`), and standalone (`npx @southcarpet/antigravity-plugin <verb>`, or `node bin/antigravity.mjs <verb>` from a clone). agy has no `plugin run` subcommand. TUI wrappers locate the copied tree with Node (`CLAUDE_PLUGIN_ROOT` when set, otherwise `~/.gemini/config/plugins/antigravity`). If that run cannot start, they must report the error and stop — they must not do the task themselves. Anything presented as a verb's output that the runtime did not produce is a fabrication. The standalone CLI is the fallback that always works. Host wrappers differ in shape; the verb set and flag contract do not.

| Verb     | What it does |
|----------|--------------|
| `setup`  | One-time OAuth wizard. Runs an authenticated `agy --print` probe in the foreground so the user can complete the Google OAuth flow visibly. Idempotent. Also registers the vision MCP server (`--skip-vision` to opt out, `--remove-vision` to undo plugin-owned entries). Foreground-only. |
| `review` | Reviews the current git diff (or `--base <ref>`). Foreground by default; pass `--background` to fork a worker and get a job id. Supports `--model <id>`, `--effort <low|medium|high|agy-default>` (no plugin default, unlike `task`/`rescue`), an optional `--focus <text>` to narrow attention, `--preview` to show what would be sent without calling agy, `--require-complete` to refuse an input that skipped a file or cut the diff, `--findings-json` to also get structured findings, checked against the plugin's schema, in `details.findings`, `--check-locations` to heuristically check each `path:line` citation against the sent diff's own hunks (local only, adds nothing to the agy call), and (with `--background --wait`) `--show-result` to print the finished job instead of the queued notice. |
| `rescue` | Delegates an investigation or fix to agy, for example `$antigravity rescue why are the tests failing`. Foreground by default; `--background` returns a job id. Supports `--model <id>`, `--effort <low|medium|high|agy-default>`, (with `--background --wait`) `--show-result`, and (with `--background`) `--request-id <id>` for an idempotent dispatch. |
| `task`   | Generic long-running delegation. Background by default; `--foreground` to inline, `--wait` to block. Supports `--continue`, `--conversation <id>`, `--prompt-file <path>` (read the prompt from a file instead of typing it; `-` reads stdin, standalone CLI only), `--add-dir <path>`, `--model <id>`, `--effort <low|medium|high|agy-default>`, `--show-result` (with `--wait`, on the background path), `--request-id <id>` (background path only: a repeat of the same request reports the existing job instead of starting a new one), `--json`. |
| `vision` | Ask agy to look at one or more image files (`--prompt`, `--model`, `--expect <text>` repeatable, `--json`). Foreground-only; needs the vision MCP server registered by `setup` (see Auth requirements below). |
| `status` | Shows current and recent jobs for this repository. Surfaces any pending OAuth URL prominently. With a job id and `--wait`, `--exit-status` exits by that job's own outcome instead of the usual 0. |
| `result` | Prints the final output of a completed job by id. `--check-locations` runs the same heuristic citation check `review --check-locations` runs, from the stored answer, even on a job reviewed without that flag. |
| `cancel` | Sends SIGTERM to a running worker by job id. |
| `doctor` | Read-only environment and configuration check: Node version, the agy binary and version, which forwarded flags `agy --help` lists, the vision configuration, and the job-state root. Never runs OAuth, never calls a model, never writes a file, never opens the network. |

For `task` and `rescue`, an explicit `low`, `medium`, or `high` is forwarded verbatim. A job with neither `--effort` nor `--model` sends `medium`, unchanged since 2.0.0. With `--model` and no `--effort`, the plugin sends no `--effort` flag. agy applies the level carried by a variant id such as `gemini-3.1-pro-high`, and rejects a base id that needs one (`raw-base-gemini-3.1-pro-no-effort.txt`). This applies since 2.0.2 because agy 1.2.11 validates the pair (`raw-model-gemini-3.1-pro-high-effort-medium.txt`, `raw-model-claude-sonnet-4-6-effort-medium.txt`). `agy-default` still sends no flag. Because `medium` runs longer than `low`, a job with neither `--model` nor `--effort` is more likely to reach the plugin's execution budget and be stored as failed with no answer. Pass `--effort low` or raise `ANTIGRAVITY_AGY_TIMEOUT_MS` to avoid this.

## Auth requirements

agy 1.0.x is **OAuth-only** — there is no API-key path yet (tracked upstream as `antigravity-cli#78`).

1. Run `$antigravity setup` (or `/antigravity:setup` from Claude Code) once per machine / account.
2. agy prints an OAuth URL — open it in a browser, complete the Google flow.
3. After that probe succeeds, later invocations of any verb do not prompt again. This plugin does not write OAuth tokens; whatever agy stores afterwards is agy's own behaviour.

If a background worker hits the auth prompt (e.g. a fresh machine), it captures the OAuth URL and surfaces it on `$antigravity status <job-id>` so you can still complete auth from a non-interactive session.

Headless verbs (background jobs, and any host-wrapper invocation) are read-and-reason: reads are granted per invocation with `--add-dir <dir>`, but execution inside agy is all-or-nothing because headless mode cannot prompt for a permission. A task that needs a command actually run must either grant everything up front or run the command yourself and hand the seat the output to judge.

When a run reports `deniedActions`, ask with the host's own question tool where the host has one whether to run that step in the host instead or to grant the action themselves, then either do the step in the host or re-run the job with `--conversation <id>` (where the verb supports it); where the host has no question tool, report the denied action and stop rather than proceeding. Never suggest `--dangerously-skip-permissions`.

`setup` also registers the **vision MCP server + exact permission** `$antigravity vision` needs — `agy --print` has no native image ingestion path, so image questions only get real visual answers once `setup` has written `~/.gemini/config/mcp_config.json` (`mcpServers.vision`) and `~/.gemini/antigravity-cli/settings.json` (`permissions.allow` including only `mcp(vision/view_image)`). Each vision run confines the server to the user-named paths. Pass `setup --skip-vision` to opt out or `setup --remove-vision` to remove only plugin-owned entries.

## Example prompts

```
$antigravity review --base main
$antigravity rescue investigate why the integration tests started failing after PR #42
$antigravity task --continue draft a migration plan from Sequelize to Drizzle
$antigravity vision ./screenshot.png --prompt "does this chart render the values 3, 5, 8?"
$antigravity status
$antigravity result 0193e2c9-...
$antigravity doctor
```

## Where this plugin lives (for Codex auto-discovery)

Codex picks this plugin up via:

- `.codex-plugin/plugin.json` — canonical Codex manifest.
- `.agents/plugins/marketplace.json` — Codex personal-marketplace descriptor.
- This `SKILL.md` at the plugin install root — skill-discovery entry.
- `agents/openai.yaml` — implicit-invocation interface (the `$antigravity` shortcut).

Claude Code, agy, and standalone hosts ignore the Codex-specific files and consume `.claude-plugin/`, `plugin.json` (root), and `bin/antigravity.mjs` respectively. See [docs/INSTALL.md](./docs/INSTALL.md) for per-host install recipes.
