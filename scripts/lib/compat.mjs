/**
 * compat: the plugin's own measured agy compatibility range, as data.
 *
 * `doctor` (scripts/commands/doctor.mjs), `setup`, and `status` all need the
 * same three facts about an agy version: the floor this plugin still works
 * with, the newest version anyone has actually run live, and whether a given
 * version is one of the rows that got that live run. This module is the one
 * place that data lives, so `docs/COMPATIBILITY.md`'s matrix table and
 * `README.md`'s "newest measured" phrase can be checked against it instead
 * of against each other (`tests/compat.test.mjs`).
 *
 * Senate R2 (2026-09).
 */

import { compareVersions } from "./update.mjs";

/** The oldest agy version this plugin still targets (docs/COMPATIBILITY.md). */
export const MIN_AGY_VERSION = "1.1.15";

/** The newest agy version anyone has run this plugin against live. */
export const LAST_MEASURED_AGY_VERSION = "1.2.12";

/**
 * Every agy version that has an actual live-run row in the
 * docs/COMPATIBILITY.md matrix table, oldest first. `tests/compat.test.mjs`
 * asserts each entry has a matching table row, and that the last entry here
 * equals {@link LAST_MEASURED_AGY_VERSION}.
 */
export const MEASURED_AGY_VERSIONS = Object.freeze([
  "1.1.15",
  "1.1.17",
  "1.1.24",
  "1.1.27",
  "1.2.1",
  "1.2.7",
  "1.2.11",
  "1.2.12",
]);

/**
 * Classification rules, in the order they are checked. Table-driven so a new
 * rule is one more row, not a new `if`/`else` branch (eslint complexity gate,
 * max 20).
 *
 * @type {{ name: string, test: (version: string | null | undefined) => boolean }[]}
 */
const CLASSIFICATION_RULES = [
  { name: "missing", test: (version) => !version },
  { name: "incompatible", test: (version) => compareVersions(version, MIN_AGY_VERSION) < 0 },
  { name: "beyond_measured", test: (version) => compareVersions(version, LAST_MEASURED_AGY_VERSION) > 0 },
  { name: "verified", test: (version) => MEASURED_AGY_VERSIONS.includes(version) },
];

/**
 * Classify an agy version against this plugin's measured range.
 *
 * - `missing`: no version (agy was not found).
 * - `incompatible`: older than {@link MIN_AGY_VERSION}.
 * - `beyond_measured`: newer than {@link LAST_MEASURED_AGY_VERSION}.
 * - `verified`: inside the range and a {@link MEASURED_AGY_VERSIONS} row.
 * - `unmeasured`: inside the range but not a matrix row (the default when
 *   no rule above matches).
 *
 * @param {string | null | undefined} version
 * @returns {"verified" | "unmeasured" | "beyond_measured" | "incompatible" | "missing"}
 */
export function classifyAgyVersion(version) {
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test(version)) return rule.name;
  }
  return "unmeasured";
}
