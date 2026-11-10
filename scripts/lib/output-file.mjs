/**
 * output-file: the one place that writes a NEW local file at a path the
 * caller chose. Two flags use it: `result --export <path>` and
 * `media --output <path>` (3.2.0, plan 153 package C).
 *
 * The rule is the same for both: the target must not exist (checked without
 * following a link), its parent directory must exist, the file is created
 * exclusively (`wx`), and a partial file is removed after a failed write.
 * Nothing is ever overwritten, appended to, or followed through a link.
 *
 * Every refusal is an {@link OutputTargetError} with a `reason` slug and a
 * message that says which case it is. The caller picks the public error
 * code (`export_target_unwritable` or `output_target_unwritable`).
 */

import fs from "node:fs";
import path from "node:path";
import { sanitizeDisplayPath } from "./fs.mjs";

/** C0 controls, DEL and C1 controls. None of them may appear in a target path. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Longest resolved path accepted: MAX_PATH minus the terminator on Windows, PATH_MAX minus one elsewhere. */
export function outputPathLimit(platform = process.platform) {
  return platform === "win32" ? 259 : 4095;
}

export class OutputTargetError extends Error {
  /**
   * @param {string} reason a stable slug naming the refusal case
   * @param {string} message one line, free of raw control characters
   */
  constructor(reason, message) {
    super(message);
    this.name = "OutputTargetError";
    this.reason = reason;
  }
}

/**
 * A path for a message or a `--json` field: one line, backticks neutralized
 * (the display sanitizer other paths use), every remaining control character
 * escaped as `\uXXXX`.
 *
 * @param {string} value
 * @returns {string}
 */
export function displayTargetPath(value) {
  return sanitizeDisplayPath(value).replace(
    CONTROL_CHARS_GLOBAL_RE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Check the SHAPE of a path value and resolve it against `cwd`. No file
 * system access. `--preview` uses this alone; the real run adds
 * {@link assertNewFileTarget}.
 *
 * @param {unknown} raw the flag value
 * @param {string} cwd the invocation cwd (`--cwd` when given)
 * @param {{ noun: string, platform?: string }} options `noun` is `export` or `output`
 * @returns {string} the absolute target path
 */
export function resolveOutputPath(raw, cwd, { noun, platform = process.platform }) {
  const text = typeof raw === "string" ? raw : "";
  if (text.trim() === "") {
    throw new OutputTargetError("empty_path", `${noun} path is empty. Give a file path after the flag.`);
  }
  if (CONTROL_CHARS_RE.test(text)) {
    throw new OutputTargetError(
      "control_character",
      `${noun} path holds a control character (shown escaped): ${displayTargetPath(text)}`,
    );
  }
  const target = path.resolve(cwd, text);
  const limit = outputPathLimit(platform);
  if (target.length > limit) {
    throw new OutputTargetError(
      "path_too_long",
      `${noun} path is longer than the ${limit} characters this platform allows.`,
    );
  }
  return target;
}

function kindOfExisting(stat) {
  if (stat.isSymbolicLink()) return "link";
  return stat.isDirectory() ? "directory" : "file";
}

function lstatOrNull(target, io, noun) {
  try {
    return io.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ENOTDIR") throw parentNotDirectory(target, noun);
    throw new OutputTargetError(
      "check_failed",
      `${noun} target cannot be checked (${error?.code ?? "error"}): ${displayTargetPath(target)}`,
    );
  }
}

function parentNotDirectory(target, noun) {
  return new OutputTargetError(
    "parent_not_directory",
    `${noun} target parent is not a directory: ${displayTargetPath(path.dirname(target))}`,
  );
}

function assertParentDirectory(target, io, noun) {
  const parent = path.dirname(target);
  let stat;
  try {
    stat = io.statSync(parent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new OutputTargetError(
        "parent_missing",
        `${noun} target directory does not exist: ${displayTargetPath(parent)}`,
      );
    }
    if (error?.code === "ENOTDIR") throw parentNotDirectory(target, noun);
    throw new OutputTargetError(
      "check_failed",
      `${noun} target directory cannot be checked (${error?.code ?? "error"}): ${displayTargetPath(parent)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw parentNotDirectory(target, noun);
  }
}

/**
 * Refuse a target that exists (a file, a directory or a link, none of them
 * followed) or whose parent directory is missing. Read-only.
 *
 * @param {string} target an absolute path from {@link resolveOutputPath}
 * @param {{ noun: string, io?: Partial<typeof defaultIo> }} options
 * @returns {void}
 */
export function assertNewFileTarget(target, { noun, io = {} }) {
  const fsIo = { ...defaultIo, ...io };
  const existing = lstatOrNull(target, fsIo, noun);
  if (existing) {
    const kind = kindOfExisting(existing);
    throw new OutputTargetError(
      `exists_${kind}`,
      `${noun} target already exists as a ${kind}: ${displayTargetPath(target)}. The plugin never overwrites.`,
    );
  }
  assertParentDirectory(target, fsIo, noun);
}

const defaultIo = {
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  openSync: fs.openSync,
  writeFileSync: fs.writeFileSync,
  closeSync: fs.closeSync,
  unlinkSync: fs.unlinkSync,
};

function createExclusive(target, fsIo, noun) {
  try {
    return fsIo.openSync(target, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new OutputTargetError(
        "exists_file",
        `${noun} target already exists: ${displayTargetPath(target)}. The plugin never overwrites.`,
      );
    }
    if (error?.code === "ENOENT") {
      throw new OutputTargetError(
        "parent_missing",
        `${noun} target directory does not exist: ${displayTargetPath(path.dirname(target))}`,
      );
    }
    throw writeFailure(target, noun, error);
  }
}

function writeFailure(target, noun, error) {
  return new OutputTargetError(
    "write_failed",
    `${noun} target cannot be written (${error?.code ?? "error"}): ${displayTargetPath(target)}. No partial file is left.`,
  );
}

/**
 * Create `target` exclusively and write `text` as UTF-8, with no byte order
 * mark. If the write fails after the file was created, the partial file is
 * removed. A file this call did not create is never touched.
 *
 * @param {string} target an absolute path from {@link resolveOutputPath}
 * @param {string} text
 * @param {{ noun: string, io?: Partial<typeof defaultIo> }} options
 * @returns {{ bytes: number }}
 */
export function writeNewTextFile(target, text, { noun, io = {} }) {
  const fsIo = { ...defaultIo, ...io };
  const data = Buffer.from(text, "utf8");
  const fd = createExclusive(target, fsIo, noun);
  try {
    fsIo.writeFileSync(fd, data);
    fsIo.closeSync(fd);
  } catch (error) {
    try { fsIo.closeSync(fd); } catch { /* already closed or invalid */ }
    try { fsIo.unlinkSync(target); } catch { /* best effort: the partial file may be gone */ }
    throw writeFailure(target, noun, error);
  }
  return { bytes: data.length };
}
