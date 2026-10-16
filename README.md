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

- Runs `agy --print` from the host you already use.
- Gives Claude Code, Codex CLI, agy, and the standalone CLI the same nine verbs.
- Reviews diffs, runs delegated prompts, analyzes named images, and manages background jobs.

## Installation and quick start

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
cd antigravity-plugin
node scripts/pack-for-agy.mjs
# Run the printed agy plugin install command, then restart agy.
# In the agy TUI:
/antigravity:<verb>
```

### Standalone

```bash
# Run from any shell:
npx @southcarpet/antigravity-plugin setup
npx @southcarpet/antigravity-plugin doctor
npx @southcarpet/antigravity-plugin review
```

If a command fails, see [Troubleshooting](./docs/INSTALL.md#troubleshooting).

## Status

> **v3.0.1.** From 3.0.0, while the first number stays 3, an update
> does not break a command or output that already works. Removals are first
> marked deprecated, stay for at least one more 3.x minor release, and happen
> only in 4.0.0. See [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md).

- 3.0.0 changed one default: `vision` now uses `gemini-3.8-flash-high`. Pass `--model gemini-3.6-flash-high` to keep the old model. See [`CHANGELOG.md`](./CHANGELOG.md).
- Plugin 3.0.1 is this package's version. agy is Google's Antigravity CLI, and its version moves separately.
- Measured agy versions span 1.1.15 to 1.4.0, newest measured 1.4.0. Coverage differs by version; see [Compatibility](./docs/COMPATIBILITY.md).
- The plugin does not update itself.
- Version numbers: **Y** in `X.Y.Z` changes for new features and larger compatible updates. **Z** changes for fixes; **X** changes only for breaking changes.

## Why this plugin

- **One command set on every host.** The same nine verbs run everywhere.
- **Clear failures.** Denied actions are reported with a remedy. An empty answer with a denied action fails.
- **Real image input.** `vision` sends pixels to agy, and `--expect` checks the transcription for text you name.
- **Reviews you can check.** `review` can preview its input, return schema-checked findings, and check cited lines against the diff.
- **Background jobs.** `status`, `result`, and `cancel` manage them, and `--request-id` prevents double dispatch.
- **Predictable runs.** `task` and `rescue` have a default effort and a time budget, and every job records its provenance.
- **Script-friendly.** `--json` writes one envelope, also for expected failures.
- **Small.** No runtime dependencies, a read-only `doctor`, CI on three systems, and releases with npm provenance and signed tags.

Flags, defaults, and exit codes: [Commands reference](./docs/COMMANDS.md). Measured limits: [Compatibility](./docs/COMPATIBILITY.md).

## How it works

- Your host or shell calls the plugin, which runs `agy --print`. agy talks to Google's service.
- `vision` uses a local MCP server that hands agy only the images you named. If agy offloads a large image, the prompt opens only that exact copy.
- Prompts, selected diffs, image bytes, and files agy reads with its own tools can reach Google's service.
- Job records stay on your machine. `status`, `result`, and `cancel` never call the model.
- If agy denies an action, the plugin reports the action, its target when known, and a remedy. Your host asks you what to do, or reports and stops.
- `setup` writes user-level files under `~/.gemini`, never the repository.

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
| `doctor` | Read-only environment check. No OAuth, model call, write, or network. |

`update` is a standalone convenience command, not one of the nine verbs. Flags and exit codes: [Commands reference](./docs/COMMANDS.md).

## Vision

- `agy --print` has no native image input, so a local MCP server delivers the pixels.
- Answers have `Transcription`, `Observations`, and `Answer` sections. If images cannot be delivered, the answer is `VISION-UNAVAILABLE: <reason>`.
- An answer from this channel is not evidence. Cross-check the transcript.
- The default model is `gemini-3.8-flash-high` (before 3.0.0: `gemini-3.6-flash-high`).
- Formats, limits, and flags: [Commands reference](./docs/COMMANDS.md#vision).

```bash
npx @southcarpet/antigravity-plugin vision ./screenshot.png --prompt "Which text is visible?"
```

## Updating

- **Standalone:** use an unversioned `npx @southcarpet/antigravity-plugin <command>`. A pinned version does not update.
- **Claude Code:** `claude plugin marketplace update antigravity`, then `claude plugin update antigravity@antigravity`, then restart.
- **Codex CLI:** `codex plugin remove antigravity@antigravity`, then `codex plugin add antigravity@antigravity`. Pull your local clone first if the marketplace is one.
- **agy:** `agy plugin uninstall antigravity`, then reinstall from a fresh packed copy. See [Installation](./docs/INSTALL.md#agy-itself).
- **Helper:** `antigravity-plugin update` checks the npm registry and prints the commands for the hosts it finds.
  - `update --apply` runs them. For Claude Code it refreshes the marketplace first. For Codex CLI with a local clone it tells you to pull the clone and never changes it. For agy it checks the downloaded package before it uninstalls the old copy, and stops with exit 1 if the check fails.
  - Run it from outside the agy install directory.
  - Set `ANTIGRAVITY_NO_UPDATE_CHECK=1` to skip the registry check.
  - More: [Commands reference](./docs/COMMANDS.md).

## Requirements

- Node.js `>= 22.3.0`.
- agy on `PATH`. See [measured versions and limits](./docs/COMPATIBILITY.md).
- A Google account for agy OAuth.

## Permissions and privacy

- `setup` changes user-level files under `~/.gemini` and registers the vision server after a successful OAuth probe.
- Each `vision` run allows only the image paths you name. The server denies every other path.
- Use `--add-dir <dir>` for access to another directory. agy controls tool permissions.
- When agy needs a permission it cannot ask for, the run reports the denial. You decide what to do next, or run the step yourself.

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
| `rescue` / `task` | Your prompt goes through `agy` to Google. agy can also read workspace files and `--add-dir` roots. |
| `vision` | Your prompt and the bytes of the named images go through the local MCP server and `agy`. |
| `status` / `result` / `cancel` | Nothing. These only read or signal local job state. |

- Secrets in diffs, prompts, or screenshots are sent, as if pasted into a Google product.
- Delegation costs tokens on Google's side. Measured use appears on stderr as `usage: total=<N> in=<N> out=<N>`.

See [Security](./SECURITY.md) for threat boundaries and vulnerability reports.

## Release integrity

- Releases use npm trusted publishing with a provenance attestation and signed tags (from v1.1.0). Steps: [Release runbook](./docs/RELEASING.md).
- Check the attestation, then the registry signature in a fresh install:

```bash
npm view @southcarpet/antigravity-plugin@<version> dist.attestations
mkdir verify && cd verify && npm init -y
npm install @southcarpet/antigravity-plugin@<version>
npm audit signatures
```

- GitHub Packages mirrors the tarball for discovery only and needs a token to install.

## Documentation

- [Installation](./docs/INSTALL.md) and [Troubleshooting](./docs/INSTALL.md#troubleshooting)
- [3.x compatibility contract](./docs/COMPATIBILITY.md)
- [Commands reference](./docs/COMMANDS.md)
- [Security](./SECURITY.md)
- [Release smoke checklist](./docs/SMOKE.md)
- [Spike findings](./docs/SPIKE-findings.md): why the project does not use ACP
- [Release runbook](./docs/RELEASING.md)

## Contributing

- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the gates, the 3.x contract, and the release flow.
- Pull requests run on Ubuntu, Windows, and macOS with Node 22.3.x and Node 24. Lint runs on the Node 24 jobs only.
- The package has no runtime dependencies. The only dev dependency is `eslint`, for the lint gate.

## Known issues

All previously tracked items are fixed. New items use the [`known issue` label](https://github.com/SouthCarpet/antigravity-plugin/issues?q=is%3Aissue+is%3Aopen+label%3A%22known+issue%22).

## Acknowledgements and license

- A maintained fork of [sakibsadmanshajib/antigravity-plugin](https://github.com/sakibsadmanshajib/antigravity-plugin), which replaces the archived [`gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc) after Google [retires Gemini CLI on June 18, 2026](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) for free and personal users.
- MIT License. See [`LICENSE`](./LICENSE).
- Antigravity and Gemini are Google's trademarks, Claude Code is Anthropic's, and Codex is OpenAI's. This project is not affiliated with or endorsed by them.
