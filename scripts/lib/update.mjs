/**
 * `antigravity-plugin update`: probe, tell, drive on request.
 *
 * A standalone dispatcher convenience in the same carve-out as `help` and
 * `--version` (docs/COMPATIBILITY.md, "Public command surface"). It is not
 * one of the eight runtime verbs and no host wrapper reaches it: a host
 * cannot replace its own copy of this plugin from inside itself. The module
 * lives under scripts/lib so that scripts/commands stays the verb set.
 *
 * Probe: one request to the npm registry (dist-tags.latest), cached 24 h in
 * the standalone state root so a host's `status` can read the answer.
 * Tell: running version, latest version, and the update command for every
 * host found on PATH. Drive: only with --apply, printing each command
 * before running it. Nothing here updates anything silently.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCommandInput } from "./args.mjs";
import { createJsonEnvelope } from "./render.mjs";
import { resolveStateRoot } from "./state.mjs";

export const PACKAGE_NAME = "@southcarpet/antigravity-plugin";
export const DIST_TAGS_URL =
  `https://registry.npmjs.org/-/package/${PACKAGE_NAME.replace("/", "%2F")}/dist-tags`;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DISABLE_ENV = "ANTIGRAVITY_NO_UPDATE_CHECK";
export const UPDATE_COMMAND = "antigravity-plugin update";

const CACHE_FILE_NAME = "update-check.json";
const FETCH_TIMEOUT_MS = 10_000;
const TARBALL_PLACEHOLDER = "<tarball>";
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The hosts this plugin ships for, with the update command each one owns.
 * `binary` is what a host is detected by on PATH; npx needs no detection
 * because an unversioned `npx` resolves `latest` on every run.
 */
export const HOSTS = [
  {
    id: "npx",
    name: "npx",
    binary: null,
    instruction: "nothing to do; an unversioned npx resolves latest on every run",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    binary: "claude",
    instruction: "claude plugin update antigravity@antigravity (restart Claude Code afterwards)",
  },
  {
    id: "codex",
    name: "Codex CLI",
    binary: "codex",
    instruction:
      "codex plugin remove antigravity, then codex plugin add antigravity@antigravity " +
      "(Codex has no plugin update subcommand)",
  },
  {
    id: "agy",
    name: "agy",
    binary: "agy",
    instruction:
      "agy plugin uninstall antigravity, then agy plugin install <published tarball> " +
      "(update --apply does this; a reinstall without the uninstall merges into the old copy)",
  },
];

export function readRunningVersion(root = PLUGIN_ROOT) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * The cache is machine-wide on purpose: it sits in the standalone state root
 * (no host variable consulted), so `status` inside Claude Code, Codex, or
 * agy sees a check that was made from any shell.
 */
export function resolveUpdateCacheFile() {
  return path.join(resolveStateRoot({}).root, CACHE_FILE_NAME);
}

export function readUpdateCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed?.latest !== "string" || typeof parsed?.checkedAt !== "string") return null;
    return { latest: parsed.latest, checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

export function isCacheFresh(entry, now = Date.now(), ttlMs = CACHE_TTL_MS) {
  const age = now - Date.parse(entry?.checkedAt ?? "");
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

function writeUpdateCache(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The answer was already obtained; a cache that cannot be written only
    // costs one more registry request next time.
  }
}

export function isCheckDisabled(env = process.env) {
  const value = env[DISABLE_ENV];
  return Boolean(value) && value !== "0";
}

function parseVersion(value) {
  const text = String(value ?? "").replace(/^v/, "").split("+")[0];
  const dash = text.indexOf("-");
  const core = (dash === -1 ? text : text.slice(0, dash))
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  while (core.length < 3) core.push(0);
  return { core, pre: dash === -1 ? "" : text.slice(dash + 1) };
}

/** Semver-shaped compare: -1, 0, 1. A prerelease sorts below its release. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export async function fetchLatestVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime");
  }
  const response = await fetchImpl(DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry answered HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body?.latest !== "string") throw new Error("registry answer has no dist-tags.latest");
  return body.latest;
}

/**
 * Resolve the latest published version: disabled, fresh cache, registry, or
 * unreachable. Never throws; a failed check is a message, not an error.
 */
export async function resolveLatest({
  env = process.env,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  cacheFile = resolveUpdateCacheFile(),
} = {}) {
  if (isCheckDisabled(env)) {
    return {
      latest: null,
      source: "disabled",
      checkedAt: null,
      message: `update check disabled (${DISABLE_ENV}=${env[DISABLE_ENV]})`,
    };
  }
  const cached = readUpdateCache(cacheFile);
  if (cached && isCacheFresh(cached, now)) {
    return { latest: cached.latest, source: "cache", checkedAt: cached.checkedAt, message: null };
  }
  try {
    const latest = await fetchLatestVersion(fetchImpl);
    const checkedAt = new Date(now).toISOString();
    writeUpdateCache(cacheFile, { latest, checkedAt });
    return { latest, source: "registry", checkedAt, message: null };
  } catch (err) {
    return {
      latest: null,
      source: "unreachable",
      checkedAt: null,
      message: `could not reach the npm registry: ${err?.message ?? err}`,
    };
  }
}

export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const raw = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of raw.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

export function detectHosts({ env = process.env, platform = process.platform } = {}) {
  return HOSTS.map((host) => {
    const binary = host.binary ? findOnPath(host.binary, { env, platform }) : null;
    return {
      id: host.id,
      name: host.name,
      present: host.binary ? binary !== null : true,
      binary,
      instruction: host.instruction,
    };
  });
}

/** The commands `--apply` runs for one present host, in order. */
export function buildHostPlan(host, { latest, tmpDir, tools = {} }) {
  const step = (command, args, extra = {}) => ({ command, args, ...extra });
  switch (host.id) {
    case "claude-code":
      return [step(host.binary, ["plugin", "update", "antigravity@antigravity"])];
    case "codex":
      return [
        step(host.binary, ["plugin", "remove", "antigravity"]),
        step(host.binary, ["plugin", "add", "antigravity@antigravity"]),
      ];
    case "agy":
      return [
        step(
          tools.npm ?? "npm",
          ["pack", `${PACKAGE_NAME}@${latest ?? "latest"}`, "--pack-destination", tmpDir, "--json"],
          { capture: "pack" },
        ),
        step(tools.tar ?? "tar", ["-xzf", TARBALL_PLACEHOLDER, "-C", tmpDir]),
        step(host.binary, ["plugin", "uninstall", "antigravity"]),
        step(host.binary, ["plugin", "install", path.join(tmpDir, "package")]),
      ];
    default:
      return [];
  }
}

/** `npm pack --json` prints `[{ filename }]`; plain `npm pack` prints the file name last. */
export function tarballFromPackOutput(stdout, destination) {
  let filename = null;
  try {
    const parsed = JSON.parse(stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first?.filename === "string") filename = first.filename;
  } catch {
    // not JSON; fall through to the last line
  }
  if (!filename) {
    const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    filename = lines.at(-1) ?? null;
  }
  if (!filename) throw new Error("npm pack printed no tarball name");
  return path.isAbsolute(filename) ? filename : path.join(destination, path.basename(filename));
}

function formatStep(step) {
  return [step.command, ...step.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

/**
 * Run one host's steps in order, printing each command first. Stops at the
 * first failure; the caller reports it. `runner` is injectable for tests.
 */
export function applyPlan(steps, { runner, write, cwd }) {
  const done = [];
  let tarball = null;
  for (const planned of steps) {
    const step = {
      ...planned,
      args: planned.args.map((arg) => (arg === TARBALL_PLACEHOLDER ? tarball ?? arg : arg)),
    };
    write(`$ ${formatStep(step)}\n`);
    const result = runner({ command: step.command, args: step.args, cwd, capture: Boolean(step.capture) });
    const status = result?.status ?? null;
    done.push({ command: step.command, args: step.args, status });
    if (result?.error || status !== 0) {
      const reason = result?.error?.message ?? `exit status ${status ?? "unknown"}`;
      return { ok: false, steps: done, message: `${step.command}: ${reason}; stopped, nothing after this step was run.` };
    }
    if (step.capture === "pack") {
      try {
        tarball = tarballFromPackOutput(result.stdout, step.args[step.args.indexOf("--pack-destination") + 1]);
      } catch (err) {
        return { ok: false, steps: done, message: `${err.message}; stopped, nothing after this step was run.` };
      }
    }
  }
  return { ok: true, steps: done, message: null };
}

function defaultRunner({ command, args, cwd, capture, childStdoutFd }) {
  // A .cmd/.bat shim (npm-installed CLIs on Windows) only runs through the
  // shell; quote what carries whitespace because the shell path does not.
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const quote = (value) => (shell && /\s/.test(value) ? `"${value}"` : value);
  const result = spawnSync(quote(command), args.map(quote), {
    cwd,
    shell,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : childStdoutFd, 2],
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error ?? null };
}

function applyToHosts(report, { deps, env, write, json }) {
  const present = report.hosts.filter((host) => host.present && host.binary);
  if (present.length === 0) {
    write("update --apply: no host with an update command was found on PATH; nothing to run.\n");
    return true;
  }
  const runner = deps.runner ?? ((step) => defaultRunner({ ...step, childStdoutFd: json ? 2 : 1 }));
  const ownTmp = !deps.tmpDir;
  const tmpDir = deps.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-update-"));
  const tools = {
    npm: findOnPath("npm", { env, platform: deps.platform }) ?? "npm",
    tar: findOnPath("tar", { env, platform: deps.platform }) ?? "tar",
  };
  let ok = true;
  for (const host of present) {
    write(`\n${host.name}:\n`);
    const outcome = applyPlan(buildHostPlan(host, { latest: report.latest, tmpDir, tools }), {
      runner,
      write,
      cwd: deps.cwd,
    });
    host.steps = outcome.steps;
    if (!outcome.ok) {
      ok = false;
      write(`${outcome.message}\n`);
    }
  }
  if (ok && ownTmp) fs.rmSync(tmpDir, { recursive: true, force: true });
  return ok;
}

function describeLatest(report) {
  if (report.source === "registry") return `${report.latest} (npm registry, checked ${report.checkedAt})`;
  if (report.source === "cache") return `${report.latest} (cached; checked ${report.checkedAt}, refreshed after 24 h)`;
  return `unknown: ${report.message}`;
}

function describeAvailability(value) {
  if (value === null) return "unknown";
  return value ? "yes" : "no";
}

export function renderUpdateReport(report) {
  const lines = [
    "# antigravity-plugin update",
    "",
    `- running: ${report.running ?? "unknown"}`,
    `- latest: ${describeLatest(report)}`,
    `- update available: ${describeAvailability(report.updateAvailable)}`,
    "",
    "Hosts on this machine:",
    "",
  ];
  for (const host of report.hosts) {
    lines.push(
      host.present
        ? `- ${host.name}: ${host.instruction}`
        : `- ${host.name}: not found on PATH (\`${HOSTS.find((h) => h.id === host.id).binary}\`); nothing to do here`,
    );
  }
  lines.push(
    "",
    "This command never changes an installed copy by itself.",
    `Run \`${UPDATE_COMMAND} --apply\` to run the commands above for the hosts that are present.`,
  );
  return `${lines.join("\n")}\n`;
}

function updateEnvelope(report, applied, ok) {
  return createJsonEnvelope("update", {
    status: applied && !ok ? "apply_failed" : "ok",
    running: report.running,
    latest: report.latest,
    updateAvailable: report.updateAvailable,
    hosts: report.hosts,
    details: {
      source: report.source,
      checkedAt: report.checkedAt,
      message: report.message,
      applied,
      note: "update is a standalone convenience, not a runtime verb; this JSON is unstable in 1.x",
    },
  });
}

/**
 * One line for `status` when the cache already knows a newer version. Reads
 * the cache only; `status` must never touch the network.
 */
export function readUpdateNotice({ cacheFile = resolveUpdateCacheFile(), running = readRunningVersion() } = {}) {
  const cached = readUpdateCache(cacheFile);
  if (!cached || !running || compareVersions(cached.latest, running) <= 0) return null;
  return `antigravity-plugin ${cached.latest} is available; run: ${UPDATE_COMMAND}`;
}

/**
 * @param {string[]} argv
 * @param {{ env?: object, now?: number, fetch?: Function, cacheFile?: string,
 *   running?: string, platform?: string, runner?: Function, tmpDir?: string, cwd?: string }} [deps]
 * @returns {Promise<number>} exit code: 0, or 1 on bad arguments or a failed --apply step
 */
export async function runUpdate(argv = [], deps = {}) {
  const parsed = readCommandInput(argv, { booleanOptions: ["apply", "json"] }, "update");
  if (!parsed) return 1;
  const json = Boolean(parsed.options.json);
  const apply = Boolean(parsed.options.apply);
  const env = deps.env ?? process.env;

  const check = await resolveLatest({ env, now: deps.now, fetchImpl: deps.fetch, cacheFile: deps.cacheFile });
  const running = deps.running ?? readRunningVersion();
  const report = {
    running,
    latest: check.latest,
    updateAvailable: running && check.latest ? compareVersions(check.latest, running) > 0 : null,
    source: check.source,
    checkedAt: check.checkedAt,
    message: check.message,
    hosts: detectHosts({ env, platform: deps.platform }),
  };

  // In JSON mode stdout is reserved for the one envelope; the apply log goes to stderr.
  const write = json ? (text) => process.stderr.write(text) : (text) => process.stdout.write(text);
  if (!json) process.stdout.write(renderUpdateReport(report));
  const ok = apply ? applyToHosts(report, { deps, env, write, json }) : true;
  if (json) process.stdout.write(`${JSON.stringify(updateEnvelope(report, apply, ok), null, 2)}\n`);
  return ok ? 0 : 1;
}
