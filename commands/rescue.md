---
description: Delegate a task to Google Antigravity (agy) for debugging, implementation, or deeper investigation
argument-hint: '[--background|--wait] [--resume|--fresh] [--continue] [--conversation <id>] [--add-dir <path>] [--model <id>] [what Antigravity should investigate, solve, or continue]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

You are a thin forwarding wrapper. Your only job is to invoke the Antigravity companion via a shell call to node and return its output. Do not spawn subagents, do not invoke skills, do not do the work yourself.

If this command cannot be run or does not succeed, print the exact error and stop. Do not do the task yourself. Do not present your own work as this plugin's output. Run this instead: `npx @southcarpet/antigravity-plugin rescue`

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, tell Claude Code to run this fork in the background.
- If the request includes `--wait`, run in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `rescue`, and do not treat them as part of the natural-language task text.
- If the request includes `--resume` or `--continue`, do not ask whether to continue — the user already chose.
- If the request includes `--fresh`, do not ask either — the user has chosen a new thread.
- Otherwise, before starting Antigravity, you MAY check whether the user wants to resume the most recent rescue thread. If unsure, ask once via `AskUserQuestion` with these two choices:
  - `Continue most recent Antigravity thread (Recommended)` when the user is clearly giving a follow-up
  - `Start a new Antigravity thread (Recommended)` otherwise

Invocation:

- Use exactly one shell call to invoke the plugin runtime and return that command's stdout as-is.
- Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/rescue.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/rescue.mjs`.
- Invoke with: `node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');const s=p.join(root,'scripts','commands','rescue.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin rescue');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin rescue');process.exit(1)}process.exit(r.status==null?1:r.status)" --` plus the remaining user arguments after `--`.
- Strip `--background` and `--wait` from the task text — they are Claude Code execution flags.
- Everything remaining after stripping flags is the task text — pass it through as the trailing positional.
- `--model <id>` is accepted but currently logged-and-ignored: agy 1.0.1 does not expose a per-invocation model flag. Forward the flag anyway so the warning surfaces in stderr.

Auth note:
- If the helper output says Antigravity is missing or not authenticated, stop and ask the user to run `/antigravity:setup`.

Output rules:

- Return the rescue companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the call fails, print the exact error and stop. Do not investigate or fix the user's request yourself.
- If the user did not supply a request, ask what Antigravity should investigate or fix.
