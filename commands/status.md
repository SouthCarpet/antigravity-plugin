---
description: Show active and recent Antigravity jobs for this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

If this command cannot be run or does not succeed, print the exact error and stop. Do not do the task yourself. Do not present your own work as this plugin's output. Run this instead: `npx @southcarpet/antigravity-plugin status`

Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/status.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/status.mjs`.

Run:

!`node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');const s=p.join(root,'scripts','commands','status.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin status');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin status');process.exit(1)}process.exit(r.status==null?1:r.status)" -- $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, Health, Last Progress, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
- Preserve health status, health message, recommended action, session ID, last heartbeat/progress/diagnostic timestamps, and any Recent Progress section.

Auth note:
- If `OAuth URL:` appears in the output, surface it prominently and tell the user to run `/antigravity:setup` to complete authentication.
