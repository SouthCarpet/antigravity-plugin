/**
 * Deterministic Windows volume for the `{ platform, fs }` seam of
 * scripts/lib/paths.mjs and scripts/mcp/vision-server.mjs.
 *
 * Nothing here touches the disk, so the 8.3 short-name cases assert the
 * same thing on every host: a Windows box with 8.3 generation off, a Linux
 * CI runner, or a volume that happens to mint aliases. The alias is what
 * NTFS with 8.3 names on would mint for `runneradmin` (the GitHub Actions
 * Windows user that first exposed the bug fixed in 1.0.1).
 *
 * Layout (long spelling; `C:\Users\RUNNER~1` is an alias of `runneradmin`):
 *
 *   C:\Users\Public\
 *   C:\Users\runneradmin\
 *   C:\Users\runneradmin\probe.png       1x1 PNG
 *   C:\Users\runneradmin\junction\       junction -> C:\outside
 *   C:\outside\secret.png                1x1 PNG
 *
 * `lstatSync` on the junction reports a symlink (as Node does for a junction
 * on Windows); `realpathSync.native` follows it and expands the alias, as
 * the real Windows call does. Inode numbers are distinct per node and shared
 * between the alias and long spelling, which is what `expandShortPath`'s
 * directory-listing + inode match relies on.
 */
import path from "node:path";

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const LONG_DIR = "C:\\Users\\runneradmin";
export const SHORT_DIR = "C:\\Users\\RUNNER~1";
export const JUNCTION_DIR = `${LONG_DIR}\\junction`;
export const JUNCTION_TARGET = "C:\\outside";

const ALIAS_RE = /^c:\\users\\runner~1(?=\\|$)/;

function fsError(code, target) {
  const err = new Error(`${code}: fixture volume, '${target}'`);
  err.code = code;
  return err;
}

/** Case-folded, alias-expanded, trailing-separator-free lookup key. */
function keyOf(input) {
  let key = path.win32.normalize(String(input)).toLowerCase();
  if (key.length > 3 && key.endsWith("\\")) key = key.slice(0, -1);
  return key.replace(ALIAS_RE, LONG_DIR.toLowerCase());
}

/**
 * @returns {{ lstatSync, readdirSync, realpathSync: { native }, statSync, readFileSync }}
 */
export function fakeVolume() {
  const png = Buffer.from(TINY_PNG_BASE64, "base64");
  const nodes = new Map();
  let nextIno = 1;
  const add = (spelled, kind, extra = {}) => {
    nodes.set(spelled.toLowerCase(), { spelled, kind, ino: nextIno++, ...extra });
  };
  add("C:\\", "dir", { names: ["Users", "outside"] });
  add("C:\\Users", "dir", { names: ["Public", "runneradmin"] });
  add("C:\\Users\\Public", "dir", { names: [] });
  add(LONG_DIR, "dir", { names: ["junction", "probe.png"] });
  add(`${LONG_DIR}\\probe.png`, "file", { data: png });
  add(JUNCTION_DIR, "junction", { target: JUNCTION_TARGET });
  add(JUNCTION_TARGET, "dir", { names: ["secret.png"] });
  add(`${JUNCTION_TARGET}\\secret.png`, "file", { data: png });

  const lookup = (input) => {
    const node = nodes.get(keyOf(input));
    if (!node) throw fsError("ENOENT", input);
    return node;
  };

  const realpath = (input) => {
    let key = keyOf(input);
    for (const node of nodes.values()) {
      if (node.kind !== "junction") continue;
      const linkKey = node.spelled.toLowerCase();
      if (key === linkKey || key.startsWith(`${linkKey}\\`)) {
        key = node.target.toLowerCase() + key.slice(linkKey.length);
      }
    }
    return lookup(key).spelled;
  };

  const statOf = (node) => ({
    ino: node.ino,
    dev: 1,
    size: node.data?.length ?? 0,
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => node.kind === "junction",
  });

  return {
    lstatSync: (input) => statOf(lookup(input)),
    readdirSync: (input) => {
      const node = lookup(input);
      if (node.kind !== "dir") throw fsError("ENOTDIR", input);
      return [...node.names];
    },
    realpathSync: { native: realpath },
    statSync: (input) => statOf(lookup(realpath(input))),
    readFileSync: (input) => {
      const node = lookup(realpath(input));
      if (node.kind !== "file") throw fsError("EISDIR", input);
      return Buffer.from(node.data);
    },
  };
}
