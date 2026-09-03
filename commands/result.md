---
description: Show the stored final output for a finished Antigravity job in this repository
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

STOP. This command runs a program. It is not a request for you to answer.

The only correct response is the unedited output of this plugin's runtime, `scripts/commands/result.mjs`, executed for this exact invocation. Output you compose yourself — with your own tools, from memory, or from the text of this file — is a fabrication, even if it looks correct. Never invent job ids, status listings, reviews, verdicts, results, or summaries in this plugin's name.

If you cannot execute the runtime, or it does not start, or it exits with an error: show the exact error text, tell the user to run `npx @southcarpet/antigravity-plugin result` in their own terminal, and stop. Do not do the task yourself. There is no other way to produce this command's output.

Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/result.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/result.mjs`.

Run:

!`node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');let ok=false;try{ok=JSON.parse(fs.readFileSync(p.join(root,'plugin.json'),'utf8')).name==='antigravity'}catch(e){ok=false}if(!ok){console.error('antigravity-plugin: '+root+' is not an antigravity plugin tree (plugin.json missing or name mismatch). Run: npx @southcarpet/antigravity-plugin result');process.exit(1)}const s=p.join(root,'scripts','commands','result.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin result');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin result');process.exit(1)}process.exit(r.status==null?1:r.status)" -- $ARGUMENTS`

Output rules:
- Present the full command output to the user.
- Do not paraphrase, summarize, condense, or add commentary.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Ask the user which issues, if any, they want fixed before touching a single file.

Auth note:
- If the stored result mentions an OAuth URL or "not authenticated", run `/antigravity:setup` to complete the OAuth flow, then re-dispatch the original request.
