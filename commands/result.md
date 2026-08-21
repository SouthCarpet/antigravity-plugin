---
description: Show the stored final output for a finished Antigravity job in this repository
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

If this command cannot be run or does not succeed, print the exact error and stop. Do not do the task yourself. Do not present your own work as this plugin's output. Run this instead: `npx @southcarpet/antigravity-plugin result`

Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/result.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/result.mjs`.

Run:

!`node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');const s=p.join(root,'scripts','commands','result.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin result');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin result');process.exit(1)}process.exit(r.status==null?1:r.status)" -- $ARGUMENTS`

Output rules:
- Present the full command output to the user.
- Do not paraphrase, summarize, condense, or add commentary.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Ask the user which issues, if any, they want fixed before touching a single file.

Auth note:
- If the stored result mentions an OAuth URL or "not authenticated", run `/antigravity:setup` to complete the OAuth flow, then re-dispatch the original request.
