# Installation

`antigravity-plugin` runs the same source tree under four hosts. Pick the one
that matches your workflow.

## Prerequisites (all hosts)

1. **Node.js ≥ 22.3.0** — `node --version`.
2. **agy CLI 1.1.15 or 1.1.17** — Google Antigravity CLI on `PATH`. Those
   are the versions this plugin has been exercised against. Other versions
   are outside the tested compatibility matrix.
   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   agy --version
   ```
3. **Google account** for `agy` OAuth. Either run `agy --print 'hi'` once and
   complete the browser flow, or use the plugin's `/antigravity:setup` wizard
   after install.

## Claude Code

```bash
claude plugin marketplace add SouthCarpet/antigravity-plugin
claude plugin install antigravity@antigravity
# inside Claude Code:
/antigravity:setup
```

## Codex CLI

Codex auto-discovers `antigravity-plugin` via three files at the plugin install
root: `.codex-plugin/plugin.json` (canonical manifest), `SKILL.md` (skill
discovery), and `agents/openai.yaml` (the `$antigravity` implicit-invocation
contract). Per the [OpenAI Codex plugin docs](https://developers.openai.com/codex/plugins/build),
plugins are registered through a marketplace descriptor at either
`$REPO_ROOT/.agents/plugins/marketplace.json` (repo-scoped) or
`~/.agents/plugins/marketplace.json` (personal).

### Option A — `codex plugin marketplace add` (recommended)

```bash
git clone https://github.com/SouthCarpet/antigravity-plugin.git ~/code/antigravity-plugin
codex plugin marketplace add ~/code/antigravity-plugin
# the local marketplace is the repo's .agents/plugins/marketplace.json
codex plugin marketplace list                    # confirm it shows up
codex plugin add antigravity@antigravity         # install; list will then show installed, enabled
# restart Codex, then inside Codex CLI:
$antigravity setup
$antigravity review --base main
```

### Option B — personal marketplace

If you prefer to keep one curated personal marketplace, copy the entry from
this repo's `.agents/plugins/marketplace.json` into `~/.agents/plugins/marketplace.json`
under the `plugins[]` array, pointing `source.path` at your local clone:

```json
{
  "name": "personal",
  "interface": { "displayName": "Personal plugins" },
  "plugins": [
    {
      "name": "antigravity",
      "source": { "source": "local", "path": "~/code/antigravity-plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity",
      "interface": { "displayName": "Antigravity (agy)" }
    }
  ]
}
```

Then install it (`codex plugin add antigravity@personal` for the example
name above) and restart Codex. The plugin is available under `$antigravity`.
Verbs: `setup`, `review`, `rescue`, `task`, `vision`, `status`, `result`,
`cancel`.

## agy itself

agy 1.1.15 and 1.1.17 can install, list, validate, enable, and disable this
plugin. They have no `plugin run` subcommand. After install, the eight verbs
are reachable two ways:

- Interactive TUI: `/antigravity:<verb>` (agy converts `commands/*.md` to
  skills). The wrapper locates the copied runtime with Node — it does not
  depend on `CLAUDE_PLUGIN_ROOT`. If that run cannot start, the skill tells
  the model to print the error and stop, not to do the task itself.
- Standalone CLI: `npx @southcarpet/antigravity-plugin <verb>`. This is the
  fallback that always works.

Install from a **clean clone**. `agy plugin install <path>` copies the entire
working tree into `~/.gemini/config/plugins/antigravity/`, including `.git`,
`.github`, and `tests/`. It does not honour `package.json` `files`. agy keeps
that copy, and reinstalling over it merges instead of replacing. **To upgrade,
run `agy plugin uninstall antigravity`, then `agy plugin install
<path-to-clean-clone>`** — otherwise the TUI can keep serving stale files.

```bash
git clone https://github.com/SouthCarpet/antigravity-plugin.git
agy plugin install ./antigravity-plugin
agy plugin list                  # expect: antigravity, with agents and commands
agy plugin validate ./antigravity-plugin
# validate reports: commands: 8 processed (converted to skills)

# TUI, after install (approve the node run if prompted):
#   /antigravity:setup
#   /antigravity:review

npx @southcarpet/antigravity-plugin setup
npx @southcarpet/antigravity-plugin review
# or from the clone:
node ./antigravity-plugin/bin/antigravity.mjs review
```

`agy plugin install antigravity@antigravity` fails with `unknown marketplace:
antigravity`. `agy plugin import claude` reports `No claude extensions found`
even when Claude Code already has the plugin.

## Standalone (any shell)

```bash
npx @southcarpet/antigravity-plugin setup
npx @southcarpet/antigravity-plugin review
npx @southcarpet/antigravity-plugin rescue 'investigate why the tests started failing'
npx @southcarpet/antigravity-plugin status
```

From a clone of this repository you can also run the dispatcher directly:

```bash
git clone https://github.com/SouthCarpet/antigravity-plugin.git
cd antigravity-plugin
node bin/antigravity.mjs review
```

## Verifying

```bash
# host-agnostic check
agy --version              # 1.1.15 or 1.1.17
node --version             # 22.3.0+
which agy                  # /home/<user>/.local/bin/agy on Linux
```

## Troubleshooting

### `agy` not found on WSL after a Windows install

The Windows Antigravity Desktop ships a symlink at `~/.local/bin/agy` that
points to the Windows binary and fails on WSL. Remove the symlink and run the
Linux installer instead:

```bash
rm -f ~/.local/bin/agy
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

### `agy --print` blocks on first run

That's the OAuth flow. Open the URL printed on stdout in your browser, paste
the resulting code back in the terminal, and the prompt continues. Subsequent
calls reuse the cached token. The plugin's `/antigravity:setup` (or
`$antigravity setup` / `npx @southcarpet/antigravity-plugin setup`) wraps
this for you.

### `agy plugin install` syntax

The form that works is `agy plugin install <path-to-clone>`. The
`<name>@<marketplace>` form and `agy plugin import claude` fail on the tested
agy versions (see above). There is no `agy plugin run`. After a plugin
upgrade, re-run `agy plugin install <path-to-clone>` so the TUI copy matches
the clone; otherwise `/antigravity:<verb>` keeps the previous wrappers.
