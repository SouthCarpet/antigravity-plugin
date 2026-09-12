<div align="center">

# antigravity-plugin

Delegate code reviews, fixes, and screenshot analysis to Google's Antigravity CLI from Claude Code, Codex CLI, agy, or your shell.

[npm](https://www.npmjs.com/package/@southcarpet/antigravity-plugin) · [Releases](https://github.com/SouthCarpet/antigravity-plugin/releases) · [Changelog](./CHANGELOG.md) · [Commands](./docs/COMMANDS.md) · [Security](./SECURITY.md)

[![npm version](https://img.shields.io/npm/v/%40southcarpet%2Fantigravity-plugin)](https://www.npmjs.com/package/@southcarpet/antigravity-plugin)
[![CI status](https://github.com/SouthCarpet/antigravity-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/SouthCarpet/antigravity-plugin/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/SouthCarpet/antigravity-plugin?label=release)](https://github.com/SouthCarpet/antigravity-plugin/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Node >=22.3.0](https://img.shields.io/badge/node-%3E%3D22.3.0-339933?logo=node.js&logoColor=white)](./package.json)
[![Known issues](https://img.shields.io/github/issues/SouthCarpet/antigravity-plugin/known%20issue?label=known%20issues&color=D93F0B)](https://github.com/SouthCarpet/antigravity-plugin/issues?q=is%3Aissue+is%3Aopen+label%3A%22known+issue%22)
[![Socket Badge](https://badge.socket.dev/npm/package/@southcarpet/antigravity-plugin)](https://socket.dev/npm/package/@southcarpet/antigravity-plugin/overview/)

</div>

## What it is

This plugin starts `agy --print` from the host that you already use. It gives Claude Code, Codex CLI, agy, and the standalone CLI the same eight verbs. You can review a diff, run a delegated prompt, analyze named images, and inspect or stop a background job from that host.

## Status

> **v1.3.0.** From 2.0.0 forward, while the first number of this version
> stays 2, an update does not break a command or an output that already
> works. If a command, flag, exit code, `--json` envelope, state location,
> or supported host is removed, release notes and documentation first mark
> it deprecated. It then stays for at least one more release that still
> starts with 2. It is removed only in version 3.0.0. That contract is in
> [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md). See
> [`CHANGELOG.md`](./CHANGELOG.md).

Plugin 1.3.0 is this package's version number. agy is Google's Antigravity
CLI. The two version lines advance independently. A new agy release does
not change the plugin version.

Plugin 1.3.0 is tested with agy 1.1.15 to 1.2.1; newest measured 1.2.1. See
[`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) for the per-version table.
The plugin does not update itself.

## Why this plugin

- **Detect denied headless tools, with a remedy.** Since agy 1.1.20, a denied tool can return `SUCCESS` with an empty answer, so the runtime changes this result to a failure that names the tool. Since agy 1.1.27, the plugin also reports agy's structured `denied_actions` list in `--json`, `status`, and `result`. Each denied action gets one remedy: `--add-dir`, `--mode accept-edits`, or a plain statement that headless mode cannot grant it. A live 1.1.27 denial of `read_url` printed `Headless runs cannot grant "read_url"; the host must run this step itself.`
- **Forward `--effort <low|medium|high|agy-default>` on `task` and `rescue`.** The plugin forwards an explicit `low`, `medium`, or `high` to agy as `--effort <value>`. When the flag is absent, it sends `medium`. `agy-default` sends no `--effort` flag, so the user's own agy configuration decides. `review` and `vision` do not support this flag.
- **Keep print-mode runs on the plugin budget.** Every print-mode `agy` call forwards `--print-timeout` as the job budget plus 60 seconds. agy's default `--print-timeout 5m0s` no longer ends a longer run first. A `0` budget forwards `24h`.
- **Disable slash expansion in print mode.** Every print-mode `agy` call forwards `--disable-slash-commands`. Prompt text that starts with `/` reaches the model as text.
- **Send real image input.** A local MCP server delivers pixels, including the offloaded-copy path used by agy 1.1.24. An ancestor directory symlink is accepted when the resolved path is an authorized entry. A requested file that is itself a symlink is refused.
- **Use one command set.** The same eight verbs run on Claude Code, Codex CLI, agy, and the standalone CLI.
- **Control background jobs.** Use `status`, `result`, and `cancel` to inspect, retrieve, or stop jobs.
- **Grant bounded reads.** `--add-dir` gives `rescue` and `task` a per-run read grant for the named directory.
- **Verify releases.** npm provenance and signed tags connect a package to its source commit.
- **Keep the runtime small.** The package has zero runtime dependencies. The test suite runs on Linux, Windows, and macOS, with Node 22.3.x and Node 24, on every change.

## Quick start

### Claude Code

```bash
claude plugin marketplace add SouthCarpet/antigravity-plugin
claude plugin install antigravity@antigravity
/antigravity:setup
/antigravity:review
```

### Codex CLI

```bash
codex plugin marketplace add <path-to-clone>
codex plugin add antigravity@antigravity
$antigravity setup
$antigravity review
```

### agy

```bash
git clone https://github.com/SouthCarpet/antigravity-plugin.git
agy plugin install <path-to-clone>
# In the agy TUI:
/antigravity:<verb>
```

### Standalone

```bash
# Run from any shell:
npx @southcarpet/antigravity-plugin setup
npx @southcarpet/antigravity-plugin review
```

If a command fails, see [Troubleshooting](./docs/INSTALL.md#troubleshooting).

## How it works

![A host command from Claude Code, Codex CLI, the agy TUI, or a plain shell enters the plugin runtime at bin/antigravity.mjs and scripts/. The eight verbs are setup, review, rescue, task, vision, status, result, and cancel. The runtime talks to agy --print over stream-json; agy talks to Google. Only the prompt, the selected diff, and named image bytes leave this machine; nothing else does. For vision, the runtime starts a local MCP server that exposes one allowlisted tool, view_image, and agy calls back into it. A background job's request, result, and log stay in the local job store on this machine; status, result, and cancel read that store and never reach Google. When agy refuses a tool in headless mode, the plugin reports the refused action and, since 1.4.0, the target it was refused on. The host then asks you with its own question tool, AskUserQuestion in Claude Code, whether to do that step in the host or to grant the action. The plugin never grants the tool and never prints a bypass flag.](./docs/how-it-works.svg)

The runtime sends prompts, selected diffs, and named image bytes through agy to Google. Background job requests, results, and logs stay in the local job store. When agy refuses a headless tool, the plugin reports the action and its target and tells the host to ask the user; it never grants the tool and never prints a bypass flag. The plugin does not create persistent wildcard grants. `setup` writes only user-level files under `~/.gemini`, not the current repository.

## Commands

| Verb | Purpose |
|---|---|
| `setup` | Run the agy OAuth probe and configure or remove the vision channel. |
| `review` | Review a working-tree or branch diff. |
| `rescue` | Delegate a prompt in a fresh or resumed conversation. |
| `task` | Run a delegated prompt, in the background by default. |
| `vision` | Analyze one or more named image files. |
| `status` | List jobs or inspect and wait for one job. |
| `result` | Read the stored result for a job. |
| `cancel` | Stop a queued or running job. |

`update` is a standalone convenience command. It is not one of the eight verbs. See [Commands reference](./docs/COMMANDS.md) for flags and exit codes.

## Vision

`agy --print` has no native image input. The local MCP server delivers the pixels. On agy 1.1.24, agy can offload a large result to a copy, and the prompt opens exactly that copy with `view_file`.

The requested answer has `Transcription`, `Observations`, and `Answer` sections. If the channel cannot deliver visual content, the answer is `VISION-UNAVAILABLE: <reason>`. An answer from this channel is not evidence. The cross-checked transcript is the evidence.

```bash
npx @southcarpet/antigravity-plugin vision ./screenshot.png --prompt "Which text is visible?"
```

See [Commands reference](./docs/COMMANDS.md#vision) for formats, limits, flags, and the measured model guidance.

## Updating

For the standalone CLI, use an unversioned `npx @southcarpet/antigravity-plugin <command>` invocation to resolve the latest published version. A pinned version does not update.

For Claude Code, run `claude plugin marketplace update antigravity` first, then `claude plugin update antigravity@antigravity`, then restart Claude Code. Without the marketplace refresh, `plugin update` reports the old version as the latest. Codex CLI has no plugin update command. Run `codex plugin remove antigravity@antigravity`, then `codex plugin add antigravity@antigravity`. Codex installs from the marketplace you registered: if that marketplace is a local clone, pull the clone first.

For agy, run `agy plugin uninstall antigravity`, then `agy plugin install <path-to-clean-clone>`. A plain reinstall merges with the old copy.

`antigravity-plugin update` checks the registry and reports the host commands. `antigravity-plugin update --apply` runs those commands for detected hosts. For Claude Code it refreshes the marketplace first. For Codex CLI it lists the marketplaces first: if the `antigravity` marketplace is a local clone, it prints the path and tells you to pull that clone, then after the install it prints the installed version and a warning when that version is not the latest. It never pulls or changes your clone. Set `ANTIGRAVITY_NO_UPDATE_CHECK=1` to skip the registry check.

## Requirements

- Node.js `>= 22.3.0`.
- agy 1.1.15 to 1.2.1 on `PATH`; newest measured 1.2.1. See [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) for the per-version table.
- A Google account for agy OAuth.

## Permissions and privacy

`setup` changes user-level files under `~/.gemini`. After a successful OAuth probe, it registers `mcpServers.vision` and the `mcp(vision/view_image)` allow rule. Each `vision` run allows only the image paths that you name. The server denies every other path and denies all access when no per-run allowlist is present.

Headless verbs (`rescue`, `task`, `review`, `vision` run through a host wrapper or in the background) are read-and-reason, not read-and-write. Reads are granted per invocation with `--add-dir <dir>` (bounded to that directory, read-only, for that run); execution inside agy is all-or-nothing, since headless mode cannot prompt for a permission. A task that needs a command actually run must either grant everything up front (accepting that risk) or run the command yourself and hand the seat the output to judge.

Undo the vision configuration without changing OAuth or job state:

```bash
# Host commands
/antigravity:setup --remove-vision
$antigravity setup --remove-vision

# Standalone command
npx @southcarpet/antigravity-plugin setup --remove-vision
```

What each verb sends:

| Verb | What leaves this machine |
|---|---|
| `setup` | Google OAuth via `agy`. The plugin itself only writes `~/.gemini`. |
| `review` | The collected git diff, untracked snippets, and review prompt go through `agy` to Google. |
| `rescue` / `task` | Your prompt goes through `agy` to Google. agy can also read workspace files and `--add-dir` roots with its own tools. |
| `vision` | Your prompt and the bytes of the named images go through the local MCP server and `agy`. |
| `status` / `result` / `cancel` | Nothing. These verbs only read or signal local job state. |

Delegation is like pasting the content into a Google product. Secrets in diffs, prompts, or screenshots are sent. Delegation also costs tokens on the Google side. When agy reports measured use, stderr contains `usage: total=<N> in=<N> out=<N>`.

See [Security](./SECURITY.md) for threat boundaries and vulnerability reports.

## Release integrity

Socket scores the published package (the badge is at the top of this page). Its supply chain score counts the capabilities this plugin needs: it starts the `agy` process, makes up to three npm registry attempts inside one 25-second budget in `update` only, reads and writes the local job store, and reads host environment variables; [Security](./SECURITY.md) and [Permissions and privacy](#permissions-and-privacy) state exactly what leaves the machine.

npmjs.org is the primary registry. Releases use npm trusted publishing and include a provenance attestation. Release tags use SSH signatures from v1.1.0 onward.

Check the attestation:

```bash
npm view @southcarpet/antigravity-plugin@<version> dist.attestations
```

Check the registry signature and attestation in a fresh install:

```bash
mkdir verify && cd verify
npm init -y
npm install @southcarpet/antigravity-plugin@<version>
npm audit signatures
```

GitHub Packages mirrors the same tarball with `--provenance=false`. It exists for discovery on the repository page and needs a token to install, even for this public package.

## Documentation

- [Installation](./docs/INSTALL.md): per-host setup recipes.
- [Troubleshooting](./docs/INSTALL.md#troubleshooting): command failures and corrective actions.
- [2.x compatibility contract](./docs/COMPATIBILITY.md): supported matrix, outputs, state, and versioning promises.
- [Commands reference](./docs/COMMANDS.md): all eight verbs, flags, defaults, and exit behavior.
- [Security](./SECURITY.md): reporting channel, scope, and what leaves the machine.
- [Release smoke checklist](./docs/SMOKE.md): four-host pre-release pass.
- [Spike findings](./docs/SPIKE-findings.md): why the project does not use ACP.
- [Release runbook](./docs/RELEASING.md): trusted publishing, signed tags, and verification.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the five gates, the frozen 2.x contract, the branch and release flow, and the docs-in-the-same-change rule. Every pull request runs the five gates on Ubuntu, Windows, and macOS with Node 22.3.x and Node 24; the lint gate runs on the Node 24 jobs only. `npm run lint` needs a Node version that eslint 10 supports (`^20.19.0 || ^22.13.0 || >=24`); CI runs it on Node 24. The tests and the rest of the runtime still support Node 22.3+.

The package has no runtime dependencies. `devDependencies` holds one entry, `eslint@^10.10.0`, pinned by `package-lock.json`, for the lint gate. The pack gate checks the files that all four hosts need and that the lockfile and lint config never ship in the tarball.

## Known issues

All previously tracked items, including [#5](https://github.com/SouthCarpet/antigravity-plugin/issues/5), are fixed. New items use the [`known issue` label](https://github.com/SouthCarpet/antigravity-plugin/issues?q=is%3Aissue+is%3Aopen+label%3A%22known+issue%22).

## Acknowledgements and license

This project is a maintained fork of [sakibsadmanshajib/antigravity-plugin](https://github.com/sakibsadmanshajib/antigravity-plugin). Credit goes to the original author for the plugin architecture. The project replaces the archived [`gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc) because Google [retires Gemini CLI on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) for free and personal users.

The code uses the MIT License. See [`LICENSE`](./LICENSE). Antigravity and Gemini are Google's trademarks. Claude Code is Anthropic's trademark. Codex is OpenAI's trademark. This project is not affiliated with or endorsed by these companies.
