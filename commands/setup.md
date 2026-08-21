---
description: One-time Google Antigravity (agy) OAuth wizard; also registers the vision MCP server
argument-hint: '[--skip-vision|--remove-vision]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/commands/setup.mjs" $ARGUMENTS`

Flags:
- Default: run an authenticated `agy --print` probe in the foreground so the OAuth URL is visible. Idempotent if credentials are already valid.
- `--skip-vision` complete OAuth only; leave vision MCP config untouched.
- `--remove-vision` remove only the persistent vision MCP entry and permission this plugin added. Does not run the OAuth probe.

FOREGROUND ONLY: this verb has no `--background`/`--wait`. The OAuth flow must be visible.

Auth note:
- agy 1.0.x is OAuth-only. Open the printed URL in a browser, complete the Google flow, then re-issue the original command.

Output rules:
- Present the command output verbatim — do not paraphrase or summarize.
