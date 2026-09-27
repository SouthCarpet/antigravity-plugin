/**
 * /antigravity:doctor — read-only environment and configuration check.
 *
 * Senate R2 (2026-09), plan 103 task 6. `doctor` never runs OAuth, never
 * calls a model, never writes a file, and never opens the network: it reads
 * `process.version`, `package.json` `engines.node`, `agy --version`,
 * `agy --help`, the two agy config files `vision-config.mjs` already knows
 * about, and the job-state root. Unlike `setup`, this is not a live probe
 * that changes anything — it is the check a caller runs first, and as often
 * as they like, with no side effect to worry about.
 *
 * Flags: `--json` and `--cwd <path>` only. No `--live`: `setup` already is
 * this plugin's live probe; a read-only verb stays read-only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readCommandInput, resolveCliCwd } from "../lib/args.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  resolveAgyBin,
  assertAgyBinSpawnable,
  probeAgy,
  probeAgyHelp,
} from "../lib/agent-runtime.mjs";
import { readVisionStatus } from "../lib/vision-config.mjs";
import { describeStateLocation } from "../lib/state.mjs";
import { compareVersions } from "../lib/update.mjs";
import {
  MIN_AGY_VERSION,
  LAST_MEASURED_AGY_VERSION,
  classifyAgyVersion,
} from "../lib/compat.mjs";
import { createJsonEnvelope, outputCommandResult } from "../lib/render.mjs";
import { runIfMain } from "../lib/cli-entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..", "..");

/**
 * Every flag the plugin forwards to agy across `review`, `rescue`, `task`,
 * and `vision`. `doctor` only checks whether each one is *listed* in
 * `agy --help`'s text, never whether it works — that distinction is in the
 * header line every text/JSON report carries.
 */
export const FORWARDED_FLAGS = Object.freeze([
  "--add-dir",
  "--model",
  "--effort",
  "--mode",
  "--continue",
  "--conversation",
  "--print-timeout",
  "--disable-slash-commands",
  "--input-format",
  "--output-format",
  "--print",
  "--json-schema",
]);

/** Bucket → line count key, shared by every check below. */
const BUCKET_KEYS = { ok: "ok", warning: "warnings", problem: "problems" };

/** agy version classification → this check's bucket. `beyond_measured` and
 * `unmeasured` are both warnings, never problems (the brief is explicit
 * about `beyond_measured`; `unmeasured` gets the same treatment `setup` and
 * `status` already give it — see their own warning lines). */
const AGY_CLASSIFICATION_BUCKET = {
  verified: "ok",
  beyond_measured: "warning",
  unmeasured: "warning",
  incompatible: "problem",
  missing: "problem",
};

/** vision-config status → this check's bucket. `absent` just means `setup`
 * has not registered vision yet (a normal state before it runs), so it is a
 * warning, not a problem — the exit-code contract only names Node, agy, and
 * the state root as problem sources. */
const VISION_BUCKET = { registered: "ok", absent: "warning", unreadable: "warning" };

function readPackageEngines() {
  try {
    const parsed = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"));
    return typeof parsed?.engines?.node === "string" ? parsed.engines.node : ">=0.0.0";
  } catch {
    return ">=0.0.0";
  }
}

function checkNode() {
  const required = readPackageEngines();
  const min = required.match(/(\d+\.\d+\.\d+)/)?.[1] ?? "0.0.0";
  const version = process.version;
  const status = compareVersions(version.replace(/^v/, ""), min) >= 0 ? "ok" : "incompatible";
  return {
    line: `Node ${version} (required ${required}) — ${status}`,
    bucket: status === "ok" ? "ok" : "problem",
    details: { version, required, status },
  };
}

async function checkAgy() {
  const bin = resolveAgyBin();
  let probe;
  try {
    assertAgyBinSpawnable(bin);
    probe = await probeAgy({ bin });
  } catch (err) {
    probe = { ok: false, reason: err?.message ?? String(err) };
  }
  const version = probe.ok ? probe.version : null;
  const classification = classifyAgyVersion(version);
  const bucket = AGY_CLASSIFICATION_BUCKET[classification];
  const binPath = probe.ok ? bin : null;
  const suffix = probe.ok ? `${bin} v${version} — ${classification}` : `not found (${probe.reason})`;
  return {
    line: `agy: ${suffix}`,
    bucket,
    details: { path: binPath, version, classification },
    bin,
  };
}

async function checkFlags(bin) {
  const probe = await probeAgyHelp({ bin });
  const help = probe.ok ? probe.help : "";
  return FORWARDED_FLAGS.map((flag) => {
    const state = help.includes(flag) ? "listed" : "not_listed";
    return {
      line: `Flag ${flag}: ${state} in --help; function not verified by this check`,
      bucket: state === "listed" ? "ok" : "warning",
      details: { flag, state },
    };
  });
}

function checkVision() {
  const status = readVisionStatus();
  const bucket = VISION_BUCKET[status.status] ?? "warning";
  const suffix = status.detail ? ` (${status.detail})` : "";
  return {
    line: `Vision config: ${status.status}${suffix}`,
    bucket,
    details: status.detail ? { status: status.status, detail: status.detail } : { status: status.status },
  };
}

function checkStateRoot(workspaceRoot) {
  let location;
  let readable = true;
  let detail;
  try {
    location = describeStateLocation(workspaceRoot);
  } catch (err) {
    readable = false;
    detail = err?.message ?? String(err);
    location = { source: "unknown", dir: null, exists: false, legacyLeaf: false };
  }
  return {
    line: readable
      ? `State root: source=${location.source} dir=${location.dir} exists=${location.exists} legacyLeaf=${location.legacyLeaf}`
      : `State root: unreadable (${detail})`,
    bucket: readable ? "ok" : "problem",
    details: readable ? location : { ...location, unreadable: true, detail },
  };
}

function tally(checks) {
  const counts = { ok: 0, warnings: 0, problems: 0 };
  for (const check of checks) counts[BUCKET_KEYS[check.bucket]] += 1;
  return counts;
}

function overallStatus(counts) {
  if (counts.problems > 0) return "problems";
  if (counts.warnings > 0) return "warnings";
  return "ok";
}

function renderMarkdown(checks, counts) {
  const lines = [
    "Header: a flag reported \"listed\" was found in `agy --help`'s text; that is not proof it works.",
    ...checks.map((c) => c.line),
    `doctor: ${counts.ok} ok, ${counts.warnings} warnings, ${counts.problems} problems`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * @param {string[]} [argv]
 * @param {{ cwd?: string }} [ctx]
 * @returns {Promise<number>}
 */
export async function run(argv = [], ctx = {}) {
  const parsed = readCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  }, "doctor");
  if (!parsed) return 1;
  const { options } = parsed;
  const json = Boolean(options.json);
  const cwd = resolveCliCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  const nodeCheck = checkNode();
  const agyCheck = await checkAgy();
  const flagChecks = await checkFlags(agyCheck.bin);
  const visionCheck = checkVision();
  const stateRootCheck = checkStateRoot(workspaceRoot);

  const checks = [nodeCheck, agyCheck, ...flagChecks, visionCheck, stateRootCheck];
  const counts = tally(checks);
  const status = overallStatus(counts);

  const details = {
    node: nodeCheck.details,
    agy: agyCheck.details,
    flags: flagChecks.map((c) => c.details),
    vision: visionCheck.details,
    stateRoot: stateRootCheck.details,
    measuredRange: { min: MIN_AGY_VERSION, newest: LAST_MEASURED_AGY_VERSION },
  };

  outputCommandResult(
    createJsonEnvelope("doctor", { status, jobId: null, answer: null, details }),
    renderMarkdown(checks, counts),
    json,
  );
  return status === "problems" ? 1 : 0;
}

export default run;

runIfMain(import.meta.url, run);
