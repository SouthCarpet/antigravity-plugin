# Installation

`antigravity-plugin` runs the same source tree under four hosts. Pick the one
that matches your workflow.

## Prerequisites (all hosts)

1. **Node.js ≥ 22.3.0** — `node --version`.
2. **agy CLI 1.1.15, 1.1.17, or 1.1.24** - Google Antigravity CLI on `PATH`.
   These versions form the tested compatibility matrix.
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
<path-to-clean-clone>`**. Otherwise, the TUI can keep serving stale files.

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

## Job state location

Tracked jobs use the first non-empty host data variable in this compatibility
order: `CLAUDE_PLUGIN_DATA`, `CODEX_PLUGIN_DATA`, then `AGY_PLUGIN_DATA`.
Standalone runs with none of these variables set use
`<os-temporary-directory>/antigravity`. Codex and agy installations upgraded
from a version that ignored their host variable continue to read and write an
existing workspace state directory at that legacy temporary location. New
workspaces use their host-owned data directory.

## Verifying

```bash
# host-agnostic check
agy --version              # 1.1.15, 1.1.17, or 1.1.24
node --version             # 22.3.0+
which agy                  # /home/<user>/.local/bin/agy on Linux
```

## Troubleshooting

The lines below come from standalone commands run from a clone of this
repository. The test commands use temporary files, temporary job stores, and a
fake `agy`. They do not contact Google.

| Situation | What you see (verbatim first line) | What to do |
|---|---|---|
| `agy` is not on `PATH`.<br><br>Commands: `node bin/antigravity.mjs setup`; `node bin/antigravity.mjs review`; `node bin/antigravity.mjs task probe --foreground` with a Node-only `PATH`. | `setup`: `antigravity:setup — \`agy\` is not on PATH (not-installed).` Exit 2.<br><br>`review`: `antigravity:review — spawnSync git ENOENT` Exit 1 because the same `PATH` also hides Git.<br><br>`task --foreground`: `antigravity:task — failed (failed).` Exit 1. The next line is `spawn error: spawn agy ENOENT`. | Install `agy`. Restore the normal `PATH`, including Git, then run `setup` again. On WSL, remove a Windows-only `~/.local/bin/agy` link and install the Linux CLI. |
| `agy` is installed, but OAuth is incomplete.<br><br>Commands: `node bin/antigravity.mjs rescue probe`; `review`; `task probe --foreground`; and `vision pixel.png --prompt probe`, with `AGY_BIN` set to the test fake. | `rescue`: `antigravity:rescue — Antigravity is not authenticated. Run /antigravity:setup, then retry.`<br><br>`review`: `antigravity:review — Antigravity is not authenticated.`<br><br>`task`: `antigravity:task — not authenticated. Run /antigravity:setup, then retry.`<br><br>`vision`: `antigravity:vision — Antigravity is not authenticated.`<br><br>Each command exits 1. The fake also produces `OAuth URL: https://accounts.google.com/o/oauth2/auth?probe=docs`. A background worker stores `auth_required` in the job state. | Run `/antigravity:setup`. Complete OAuth, then retry. For a background job, use `status` or `result` to inspect its health and OAuth URL. |
| The installed `agy` version is outside the tested matrix.<br><br>Command: `node bin/antigravity.mjs setup --skip-vision` with a fake `agy` version 9.9.9. | `antigravity:setup — using <path to agy> v9.9.9` Exit 0. `setup` reports the version and does not enforce the matrix. | Use agy 1.1.15, 1.1.17, or 1.1.24 for tested behavior. |
| A `vision` file does not exist.<br><br>Command: `node bin/antigravity.mjs vision Z:\missing.png --prompt probe`. | `antigravity:vision — image file not found: Z:\missing.png` Exit 1. | Correct the path and retry. |
| A `vision` file has an unsupported extension.<br><br>Command: `node bin/antigravity.mjs vision note.txt --prompt probe`. | `antigravity:vision — unsupported image extension ".txt": <path>\note.txt. Supported: .png, .jpg, .jpeg, .webp, .gif` Exit 1. The command checks the extension before it starts `agy`, so the run costs no tokens. | Use `.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif`. |
| A `vision` file is over 10 MiB.<br><br>Command: `node bin/antigravity.mjs vision large.png --prompt probe` with an 11 MiB file. | `antigravity:vision — image too large (11534336 bytes > 10485760 byte cap): <path>\large.png` Exit 1. The command checks the size before it starts `agy`, so the run costs no tokens. | Reduce the file to 10 MiB or less. |
| `vision` receives `--add-dir`.<br><br>Command: `node bin/antigravity.mjs vision pixel.png --add-dir C:\scope`. | `antigravity:vision — vision does not take --add-dir; the images named on the command line are the only files the model may see.` Exit 1. | Remove `--add-dir`. Name each image path on the command line. |
| `rescue` or `task` receives `--mode yolo`.<br><br>Commands: `node bin/antigravity.mjs rescue probe --mode yolo`; `node bin/antigravity.mjs task probe --mode yolo`. | `rescue`: `antigravity:rescue — invalid value for --mode: "yolo" (expected plan\|accept-edits)`<br><br>`task`: `antigravity:task — invalid value for --mode: "yolo" (expected plan\|accept-edits)`<br><br>Each command exits 1. | Use `--mode plan` or `--mode accept-edits`. |
| `result` receives an unknown job ID.<br><br>Command: `node bin/antigravity.mjs result unknown-job-id`. | `antigravity:result — No job found for "unknown-job-id". Run /antigravity:status to inspect active jobs.` Exit 1. | Run `status` and use a listed finished job ID. |
| `cancel` receives the ID of a finished job.<br><br>Command: `node bin/antigravity.mjs cancel a0a74eadce4a` after that job completed. | `antigravity:cancel — No active antigravity jobs to cancel.` Exit 1. | Use `result` to read the finished job. Cancel only a queued or running job. |
| `update --apply` runs with `ANTIGRAVITY_NO_UPDATE_CHECK=1`.<br><br>Command: `$env:ANTIGRAVITY_NO_UPDATE_CHECK='1'; node bin/antigravity.mjs update --apply`, with fake host binaries and a recording runner. | `agy: update check disabled (ANTIGRAVITY_NO_UPDATE_CHECK=1); no known "latest" version to pack, skipping this host.` Exit 1. Claude Code and Codex steps still run. | Allow the registry check before you apply an agy update. You can update the other detected hosts while the check stays disabled. |
| The npm registry is unreachable during `update`.<br><br>Command: `node bin/antigravity.mjs update`, with `fetch` forced to fail offline. | `- latest: unknown: could not reach the npm registry: probe offline` Exit 0. A failed check is a message, not a command error. | Check the network and run `update` again. You can still use the printed host instructions. |
| Two copies of the test suite run at the same time on one machine.<br><br>Command: `node --test --experimental-test-module-mocks tests/*.test.mjs`. | A `job-lifecycle` test or one `denial-verbs` case can fail. Both suites share the fake `agy` template cache in the OS temporary directory. | Run the test suite alone in the foreground. |

### `agy` not found on WSL after a Windows install

The Windows Antigravity Desktop ships a symlink at `~/.local/bin/agy` that
points to the Windows binary and fails on WSL. Remove the symlink and run the
Linux installer instead:

```bash
rm -f ~/.local/bin/agy
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

### `agy --print` blocks on first run

That is the OAuth flow. Open the URL printed on stdout in your browser, paste
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
