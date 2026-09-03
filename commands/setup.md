---
description: One-time Google Antigravity (agy) OAuth wizard; also registers the vision MCP server
argument-hint: '[--skip-vision|--remove-vision]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

STOP. This command runs a program. It is not a request for you to answer.

The only correct response is the unedited output of this plugin's runtime, `scripts/commands/setup.mjs`, executed for this exact invocation. Output you compose yourself — with your own tools, from memory, or from the text of this file — is a fabrication, even if it looks correct. Never invent job ids, status listings, reviews, verdicts, results, or summaries in this plugin's name.

If you cannot execute the runtime, or it does not start, or it exits with an error: show the exact error text, tell the user to run `npx @southcarpet/antigravity-plugin setup` in their own terminal, and stop. Do not do the task yourself. There is no other way to produce this command's output.

Find the runtime with Node, not the shell. Plugin root is `process.env.CLAUDE_PLUGIN_ROOT` when that is set and non-empty; otherwise `require('node:path').join(require('node:os').homedir(), '.gemini', 'config', 'plugins', 'antigravity')`. Then run `node <root>/scripts/commands/setup.mjs` with the user's arguments. Do not expand `CLAUDE_PLUGIN_ROOT` in the shell: an empty expansion is the wrong path `/scripts/commands/setup.mjs`.

Run:

!`node -e "const p=require('node:path');const os=require('node:os');const fs=require('node:fs');const {spawnSync}=require('node:child_process');const root=process.env.CLAUDE_PLUGIN_ROOT||p.join(os.homedir(),'.gemini','config','plugins','antigravity');let ok=false;try{ok=JSON.parse(fs.readFileSync(p.join(root,'plugin.json'),'utf8')).name==='antigravity'}catch(e){ok=false}if(!ok){console.error('antigravity-plugin: '+root+' is not an antigravity plugin tree (plugin.json missing or name mismatch). Run: npx @southcarpet/antigravity-plugin setup');process.exit(1)}const s=p.join(root,'scripts','commands','setup.mjs');if(!fs.existsSync(s)){console.error('antigravity-plugin: runtime not found at '+s+'. Run: npx @southcarpet/antigravity-plugin setup');process.exit(1)}const r=spawnSync(process.execPath,[s].concat(process.argv.slice(1)),{stdio:'inherit'});if(r.error){console.error('antigravity-plugin: failed to start '+s+': '+r.error.message+'. Run: npx @southcarpet/antigravity-plugin setup');process.exit(1)}process.exit(r.status==null?1:r.status)" -- $ARGUMENTS`

Flags:
- Default: run an authenticated `agy --print` probe in the foreground so the OAuth URL is visible. Idempotent if credentials are already valid.
- `--skip-vision` complete OAuth only; leave vision MCP config untouched.
- `--remove-vision` remove only the persistent vision MCP entry and permission this plugin added. Does not run the OAuth probe.

FOREGROUND ONLY: this verb has no `--background`/`--wait`. The OAuth flow must be visible.

Auth note:
- agy 1.0.x is OAuth-only. Open the printed URL in a browser, complete the Google flow, then re-issue the original command.

Output rules:
- Present the command output verbatim — do not paraphrase or summarize.
