/**
 * vision-config — safely register or remove the vision MCP integration.
 *
 * The two agy config files are read-modify-written under a cross-process
 * lock. Writes use a temporary sibling + rename, unrelated keys survive,
 * foreign `mcpServers.vision` entries are never replaced, and existing
 * files receive at most one same-day backup before their first change.
 *
 * A small ownership receipt records only entries this plugin added so
 * uninstall can preserve matching rules that were already present. Public
 * operations report filesystem/JSON/lock failures as warnings rather than
 * throwing; invalid files are left byte-for-byte untouched.
 *
 * Every public operation accepts `{ homeDir }`, allowing tests and callers
 * to redirect all `.gemini` access away from the real user home.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLockSync } from "./file-lock.mjs";

export const VISION_PERMISSION = "mcp(vision/view_image)";
const LEGACY_PERMISSIONS = ["read_file(*)", "view_image(*)", "mcp(*)"];
const RECEIPT_VERSION = 1;

function todayStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function pathsFor(homeDir) {
  return {
    mcp: path.join(homeDir, ".gemini", "config", "mcp_config.json"),
    settings: path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
    receipt: path.join(homeDir, ".gemini", "antigravity-plugin-vision.json"),
    lock: path.join(homeDir, ".gemini", "antigravity-plugin-vision.lock"),
  };
}

function readJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return { value: {}, existed: false, raw: "" };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { error: `could not read ${filePath}: ${err.message}` };
  }
  if (!raw.trim()) return { value: {}, existed: true, raw };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${filePath} does not contain a JSON object — left untouched` };
    }
    return { value: parsed, existed: true, raw };
  } catch (err) {
    return { error: `${filePath} contains invalid JSON — left untouched (${err.message})` };
  }
}

function jsonBody(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(filePath, body) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function backupIfMissingForToday(filePath, read, now = new Date()) {
  if (!read.existed) return;
  const backupPath = `${filePath}.bak-${todayStamp(now)}`;
  if (!fs.existsSync(backupPath)) writeAtomic(backupPath, read.raw);
}

function withConfigLock(homeDir, fn, { lockTimeoutMs = 2000, staleLockMs = 60_000 } = {}) {
  const { lock } = pathsFor(homeDir);
  try {
    return withFileLockSync(lock, fn, { lockTimeoutMs, staleLockMs });
  } catch (err) {
    if (String(err?.message).startsWith("timed out waiting for lock:")) {
      throw new Error(`vision config is locked by another process: ${lock}`);
    }
    throw err;
  }
}

function desiredMcp(serverPath, nodePath = process.execPath) {
  return { command: nodePath, args: [serverPath] };
}

function sameArgs(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function isDesiredMcp(entry, desired) {
  return Boolean(entry && entry.command === desired.command && sameArgs(entry.args, desired.args));
}

function isPluginMcp(entry, serverPaths, nodePaths) {
  return Boolean(
    entry &&
    nodePaths.filter((value) => typeof value === "string").includes(entry.command) &&
    serverPaths.filter((value) => typeof value === "string").some((serverPath) => sameArgs(entry.args, [serverPath])),
  );
}

function mcpPlan(read, serverPath, nodePath, ownership = {}) {
  const config = read.value;
  if (config.mcpServers !== undefined &&
      (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    return { error: "mcp_config.json has a non-object mcpServers value — left untouched" };
  }
  const servers = config.mcpServers ?? {};
  const existing = servers.vision;
  const desired = desiredMcp(serverPath, nodePath);
  const pluginOwned = isPluginMcp(
    existing,
    [serverPath, ownership.serverPath],
    ["node", nodePath, ownership.nodePath],
  );
  if (existing && !pluginOwned) {
    return { error: "conflict: mcpServers.vision already belongs to another server; refusing to overwrite it" };
  }
  const changed = !isDesiredMcp(existing, desired);
  return {
    changed,
    legacy: Boolean(existing && existing.command === "node"),
    added: !existing,
    next: changed ? { ...config, mcpServers: { ...servers, vision: desired } } : config,
  };
}

function permissionsPlan(read, { removeLegacy = false } = {}) {
  const settings = read.value;
  if (settings.permissions !== undefined &&
      (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions))) {
    return { error: "settings.json has a non-object permissions value — left untouched" };
  }
  const permissions = settings.permissions ?? {};
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    return { error: "settings.json has a non-array permissions.allow value — left untouched" };
  }
  const allow = permissions.allow ?? [];
  const withoutLegacy = removeLegacy ? allow.filter((rule) => !LEGACY_PERMISSIONS.includes(rule)) : allow;
  const added = !withoutLegacy.includes(VISION_PERMISSION);
  const nextAllow = added ? [...withoutLegacy, VISION_PERMISSION] : withoutLegacy;
  const changed = nextAllow.length !== allow.length || nextAllow.some((rule, i) => rule !== allow[i]) || !settings.permissions;
  return {
    changed,
    added,
    removedLegacy: allow.filter((rule) => LEGACY_PERMISSIONS.includes(rule)),
    next: changed ? { ...settings, permissions: { ...permissions, allow: nextAllow } } : settings,
  };
}

function applyBatch(operations) {
  for (const op of operations.filter((item) => item.backup)) {
    backupIfMissingForToday(op.filePath, op.read);
  }
  const applied = [];
  try {
    for (const op of operations) {
      if (op.delete) fs.unlinkSync(op.filePath);
      else writeAtomic(op.filePath, op.body);
      applied.push(op);
    }
  } catch (err) {
    const rollbackErrors = [];
    for (const op of applied.reverse()) {
      try {
        if (op.read.existed) writeAtomic(op.filePath, op.read.raw);
        else fs.unlinkSync(op.filePath);
      } catch (rollbackErr) {
        rollbackErrors.push(`${op.filePath}: ${rollbackErr.message}`);
      }
    }
    const suffix = rollbackErrors.length ? `; rollback also failed (${rollbackErrors.join("; ")})` : "";
    throw new Error(`${err.message}${suffix}`);
  }
}

function failureResult(filePath, error) {
  return { changed: false, warning: error instanceof Error ? error.message : String(error), filePath };
}

export function resolveVisionServerPath() {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "mcp", "vision-server.mjs");
}

export function ensureMcpConfig({
  homeDir = os.homedir(),
  serverPath = resolveVisionServerPath(),
  nodePath = process.execPath,
  lockTimeoutMs,
} = {}) {
  const filePath = pathsFor(homeDir).mcp;
  try {
    return withConfigLock(homeDir, () => {
      const read = readJsonConfig(filePath);
      if (read.error) return failureResult(filePath, read.error);
      const plan = mcpPlan(read, serverPath, nodePath);
      if (plan.error) return failureResult(filePath, plan.error);
      if (!plan.changed) return { changed: false, filePath };
      backupIfMissingForToday(filePath, read);
      writeAtomic(filePath, jsonBody(plan.next));
      return { changed: true, filePath };
    }, { lockTimeoutMs });
  } catch (err) {
    return failureResult(filePath, `could not update ${filePath}: ${err.message}`);
  }
}

export function ensurePermissions({ homeDir = os.homedir(), lockTimeoutMs } = {}) {
  const filePath = pathsFor(homeDir).settings;
  try {
    return withConfigLock(homeDir, () => {
      const read = readJsonConfig(filePath);
      if (read.error) return failureResult(filePath, read.error);
      const plan = permissionsPlan(read);
      if (plan.error) return failureResult(filePath, plan.error);
      if (!plan.changed) return { changed: false, filePath };
      backupIfMissingForToday(filePath, read);
      writeAtomic(filePath, jsonBody(plan.next));
      return { changed: true, filePath };
    }, { lockTimeoutMs });
  } catch (err) {
    return failureResult(filePath, `could not update ${filePath}: ${err.message}`);
  }
}

export function ensureVisionConfig({
  homeDir = os.homedir(),
  serverPath = resolveVisionServerPath(),
  nodePath = process.execPath,
  lockTimeoutMs,
} = {}) {
  const files = pathsFor(homeDir);
  const empty = {
    mcpConfig: { changed: false, filePath: files.mcp },
    permissions: { changed: false, filePath: files.settings },
  };
  try {
    return withConfigLock(homeDir, () => {
      const mcpRead = readJsonConfig(files.mcp);
      const settingsRead = readJsonConfig(files.settings);
      const receiptRead = readJsonConfig(files.receipt);
      const readError = mcpRead.error || settingsRead.error || receiptRead.error;
      if (readError) return { ...empty, ok: false, summary: [`configuration unchanged: ${readError}`] };

      const previousReceipt = receiptRead.value.version === RECEIPT_VERSION ? receiptRead.value : {};
      const mcp = mcpPlan(mcpRead, serverPath, nodePath, previousReceipt);
      if (mcp.error) return { ...empty, ok: false, summary: [`configuration unchanged: ${mcp.error}`] };
      const permissions = permissionsPlan(settingsRead, { removeLegacy: mcp.legacy });
      if (permissions.error) return { ...empty, ok: false, summary: [`configuration unchanged: ${permissions.error}`] };

      const receipt = {
        version: RECEIPT_VERSION,
        serverPath,
        nodePath,
        mcpEntryAdded: Boolean(previousReceipt.mcpEntryAdded || mcp.added || mcp.legacy),
        permissionRuleAdded: Boolean(previousReceipt.permissionRuleAdded || permissions.added),
      };
      const receiptNeeded = receipt.mcpEntryAdded || receipt.permissionRuleAdded;
      const receiptChanged = receiptNeeded && jsonBody(receipt) !== receiptRead.raw;
      const operations = [];
      if (mcp.changed) operations.push({ filePath: files.mcp, read: mcpRead, body: jsonBody(mcp.next), backup: true });
      if (permissions.changed) operations.push({ filePath: files.settings, read: settingsRead, body: jsonBody(permissions.next), backup: true });
      if (receiptChanged) operations.push({ filePath: files.receipt, read: receiptRead, body: jsonBody(receipt) });
      applyBatch(operations);

      return {
        ok: true,
        mcpConfig: { changed: mcp.changed, filePath: files.mcp },
        permissions: { changed: permissions.changed, filePath: files.settings },
        summary: [
          mcp.changed ? "mcp_config.json: registered the vision MCP server with the current Node executable" : "mcp_config.json: already configured",
          permissions.changed
            ? `settings.json: allowed only ${VISION_PERMISSION}${permissions.removedLegacy.length ? " and removed legacy wildcard grants" : ""}`
            : "settings.json: already configured",
          receiptChanged ? "ownership receipt: recorded entries added by this plugin" : "ownership receipt: already current or not needed",
        ],
      };
    }, { lockTimeoutMs });
  } catch (err) {
    return { ...empty, ok: false, summary: [`configuration unchanged: ${err.message}`] };
  }
}

export function removeVisionConfig({
  homeDir = os.homedir(),
  serverPath = resolveVisionServerPath(),
  lockTimeoutMs,
} = {}) {
  const files = pathsFor(homeDir);
  try {
    return withConfigLock(homeDir, () => {
      const mcpRead = readJsonConfig(files.mcp);
      const settingsRead = readJsonConfig(files.settings);
      const receiptRead = readJsonConfig(files.receipt);
      const readError = mcpRead.error || settingsRead.error || receiptRead.error;
      if (readError) return { ok: false, changed: false, summary: [`configuration unchanged: ${readError}`] };

      const receipt = receiptRead.value.version === RECEIPT_VERSION ? receiptRead.value : null;
      const servers = mcpRead.value.mcpServers;
      if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
        return { ok: false, changed: false, summary: ["configuration unchanged: mcp_config.json has a non-object mcpServers value"] };
      }
      const existing = servers?.vision;
      const ownedServerPath = receipt?.serverPath;
      const pluginOwned = isPluginMcp(
        existing,
        [serverPath, ownedServerPath],
        ["node", process.execPath, receipt?.nodePath],
      );
      const legacy = Boolean(existing && existing.command === "node" && pluginOwned);
      const removeMcp = Boolean(existing && pluginOwned && (receipt?.mcpEntryAdded || legacy));
      if (receipt?.mcpEntryAdded && existing && !pluginOwned) {
        return { ok: false, changed: false, summary: ["configuration unchanged: mcpServers.vision changed ownership; refusing to remove it"] };
      }

      const permissions = settingsRead.value.permissions;
      if (permissions !== undefined && (!permissions || typeof permissions !== "object" || Array.isArray(permissions))) {
        return { ok: false, changed: false, summary: ["configuration unchanged: settings.json has a non-object permissions value"] };
      }
      const allow = permissions?.allow ?? [];
      if (!Array.isArray(allow)) {
        return { ok: false, changed: false, summary: ["configuration unchanged: settings.json has a non-array permissions.allow value"] };
      }
      const removableRules = new Set();
      if (receipt?.permissionRuleAdded) removableRules.add(VISION_PERMISSION);
      if (legacy && !receipt) for (const rule of LEGACY_PERMISSIONS) removableRules.add(rule);
      const nextAllow = allow.filter((rule) => !removableRules.has(rule));
      const removePermissions = nextAllow.length !== allow.length;

      const operations = [];
      if (removeMcp) {
        const { vision: _vision, ...otherServers } = servers;
        operations.push({
          filePath: files.mcp,
          read: mcpRead,
          body: jsonBody({ ...mcpRead.value, mcpServers: otherServers }),
          backup: true,
        });
      }
      if (removePermissions) {
        operations.push({
          filePath: files.settings,
          read: settingsRead,
          body: jsonBody({ ...settingsRead.value, permissions: { ...permissions, allow: nextAllow } }),
          backup: true,
        });
      }
      if (receiptRead.existed) operations.push({ filePath: files.receipt, read: receiptRead, delete: true });
      applyBatch(operations);

      return {
        ok: true,
        changed: operations.length > 0,
        summary: [
          removeMcp ? "mcp_config.json: removed this plugin's vision server" : "mcp_config.json: no plugin-owned vision server to remove",
          removePermissions ? "settings.json: removed only vision rules added by this plugin" : "settings.json: no plugin-owned vision rules to remove",
          receiptRead.existed ? "ownership receipt: removed" : "ownership receipt: not present",
        ],
      };
    }, { lockTimeoutMs });
  } catch (err) {
    return { ok: false, changed: false, summary: [`configuration unchanged: ${err.message}`] };
  }
}
