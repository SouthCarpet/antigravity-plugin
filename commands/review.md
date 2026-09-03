---
description: Review uncommitted changes (or a branch diff) with Google Antigravity (agy)
argument-hint: '[--base <ref>] [--scope <auto|working-tree|branch>] [--background] [--wait] [--continue] [--conversation <id>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

STOP. This command runs a program. It is not a request for you to answer.

The only correct response is the unedited output of this plugin's runtime, `scripts/commands/review.mjs`, executed for this exact invocation. Output you compose yourself — with your own tools, from memory, or from the text of this file — is a fabrication, even if it looks correct. Never invent job ids, status listings, reviews, verdicts, results, or summaries in this plugin's name.

If you cannot execute the runtime, or it does not start, or it exits with an error: show the exact error text, tell the user to run `npx @southcarpet/antigravity-plugin review` in their own terminal, and stop. Do not do the task yourself. There is no other way to produce this command's output.

Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/review.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/review.mjs`.

Run:

!`node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');let ok=false;try{ok=JSON.parse(fs.readFileSync(p.join(root,'plugin.json'),'utf8')).name==='antigravity'}catch(e){ok=false}if(!ok){console.error('antigravity-plugin: '+root+' is not an antigravity plugin tree (plugin.json missing or name mismatch). Run: npx @southcarpet/antigravity-plugin review');process.exit(1)}const s=p.join(root,'scripts','commands','review.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin review');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin review');process.exit(1)}process.exit(r.status==null?1:r.status)" -- $ARGUMENTS`

Flags:
- `--base <ref>` review the diff between HEAD and `<ref>` (e.g. `main`).
- `--scope <auto|working-tree|branch>` overrides the auto-detection. Default `auto`.
- `--background` fork a worker, return immediately. Use `/antigravity:status` to poll.
- `--wait` combined with `--background`, block until completion.
- `--continue` resume the most recent review conversation.
- `--conversation <id>` resume a specific conversation by id.
- `--json` emit structured JSON instead of the rendered markdown review.

Auth note:
- If the output says "Antigravity is not authenticated", run `/antigravity:setup` to complete the OAuth flow and then re-try.

Output rules:
- Present the review output to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- Do not make any code changes based on the review findings. If the user wants a fix, ask them which finding to address first.
- If the output is empty or indicates no changes, say so explicitly.
