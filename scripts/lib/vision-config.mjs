/**
 * vision-config — idempotently registers the vision MCP server + the
 * permissions agy needs to answer image questions unattended.
 *
 * Owns two files under `<homeDir>`:
 *   .gemini/config/mcp_config.json          — mcpServers.vision = { command, args }
 *   .gemini/antigravity-cli/settings.json   — permissions.allow += read_file(*), view_image(*), mcp(*)
 *
 * `~/.gemini/settings.json` (no `antigravity-cli` segment) is a different,
 * ignored file for this CLI version — do not confuse the two.
 *
 * Both files are merged (never blindly overwritten): unrelated keys are
 * preserved, invalid JSON aborts just that file with a warning instead of
 * clobbering it, and a same-day backup is written before the first change.
 * All functions take `{ homeDir }` so callers (and tests) can redirect to a
 * temp directory instead of the real `~/.gemini`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Permissions agy needs, in headless print mode, to allow the vision tools. */
const REQUIRED_PERMISSIONS = ["read_file(*)", "view_image(*)", "mcp(*)"];

function todayStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Write `<filePath>.bak-<yyyymmdd>` once per day, only if the file already exists. */
function backupIfMissingForToday(filePath, now = new Date()) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.bak-${todayStamp(now)}`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
}

/** Read + JSON-parse a config file. Missing/empty → `{}`; invalid JSON → `{ error }`. */
function readJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return { value: {} };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { error: `could not read ${filePath}: ${err.message}` };
  }
  if (!raw || !raw.trim()) return { value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${filePath} does not contain a JSON object — left untouched` };
    }
    return { value: parsed };
  } catch (err) {
    return { error: `${filePath} contains invalid JSON — left untouched (${err.message})` };
  }
}

/**
 * Resolve the absolute path to scripts/mcp/vision-server.mjs from this
 * module's own location, so it works regardless of where the plugin is
 * installed.
 *
 * @returns {string}
 */
export function resolveVisionServerPath() {
  const here = fileURLToPath(import.meta.url); // .../scripts/lib/vision-config.mjs
  return path.resolve(path.dirname(here), "..", "mcp", "vision-server.mjs");
}

/**
 * Ensure `<homeDir>/.gemini/config/mcp_config.json` registers the `vision`
 * MCP server. Idempotent: a no-op (no write, no backup) when already correct.
 *
 * @param {{ homeDir?: string, serverPath?: string }} [options]
 * @returns {{ changed: boolean, warning?: string, filePath: string }}
 */
export function ensureMcpConfig({ homeDir = os.homedir(), serverPath = resolveVisionServerPath() } = {}) {
  const filePath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
  const read = readJsonConfig(filePath);
  if (read.error) return { changed: false, warning: read.error, filePath };

  const config = read.value;
  const mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  const desired = { command: "node", args: [serverPath] };
  const existing = mcpServers.vision;
  const alreadyCorrect =
    existing &&
    existing.command === desired.command &&
    Array.isArray(existing.args) &&
    existing.args.length === desired.args.length &&
    existing.args.every((a, i) => a === desired.args[i]);

  if (alreadyCorrect) return { changed: false, filePath };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupIfMissingForToday(filePath);

  const next = { ...config, mcpServers: { ...mcpServers, vision: desired } };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed: true, filePath };
}

/**
 * Ensure `<homeDir>/.gemini/antigravity-cli/settings.json` grants
 * `read_file(*)`, `view_image(*)`, `mcp(*)` in `permissions.allow`.
 * Idempotent: a no-op when all three are already present.
 *
 * @param {{ homeDir?: string }} [options]
 * @returns {{ changed: boolean, warning?: string, filePath: string }}
 */
export function ensurePermissions({ homeDir = os.homedir() } = {}) {
  const filePath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const read = readJsonConfig(filePath);
  if (read.error) return { changed: false, warning: read.error, filePath };

  const settings = read.value;
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const missing = REQUIRED_PERMISSIONS.filter((p) => !allow.includes(p));

  if (missing.length === 0 && settings.permissions) return { changed: false, filePath };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupIfMissingForToday(filePath);

  const next = { ...settings, permissions: { ...permissions, allow: [...allow, ...missing] } };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed: true, filePath };
}

/**
 * Idempotently ensure both the MCP server registration and the CLI
 * permission allow-list that `/antigravity:vision` needs to work
 * unattended. Never throws — invalid JSON in either file is reported as a
 * warning and that file is left untouched rather than clobbered.
 *
 * @param {{ homeDir?: string }} [options]
 * @returns {{
 *   mcpConfig: { changed: boolean, warning?: string, filePath: string },
 *   permissions: { changed: boolean, warning?: string, filePath: string },
 *   summary: string[],
 * }}
 */
export function ensureVisionConfig({ homeDir = os.homedir() } = {}) {
  const mcpConfig = ensureMcpConfig({ homeDir });
  const permissions = ensurePermissions({ homeDir });

  const summary = [
    mcpConfig.warning
      ? `mcp_config.json: ${mcpConfig.warning}`
      : mcpConfig.changed
      ? "mcp_config.json: registered the vision MCP server"
      : "mcp_config.json: already configured",
    permissions.warning
      ? `settings.json: ${permissions.warning}`
      : permissions.changed
      ? "settings.json: added missing vision permissions"
      : "settings.json: already configured",
  ];

  return { mcpConfig, permissions, summary };
}
