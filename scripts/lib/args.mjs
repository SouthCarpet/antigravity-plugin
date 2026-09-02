/**
 * Lightweight argument parser for the antigravity-plugin CLI.
 * Mirrors the Codex plugin's args.mjs.
 */

/**
 * @typedef {{
 *   valueOptions?: string[],
 *   booleanOptions?: string[],
 *   repeatableOptions?: string[],
 *   valueChoices?: Record<string, string[]>,
 *   conflicts?: string[][],
 * }} ArgSchema
 *
 * Repeatable-option contract:
 *   An option listed in `repeatableOptions` always yields an array when
 *   present, including a single occurrence (`['only']`, never `'only'`).
 *   Absent repeatable options stay unset (`undefined`), not `[]`.
 *   Scalar `valueOptions` keep last-wins string behaviour.
 *
 * `valueChoices` restricts a scalar value option to the listed strings; any
 * other value throws {@link ArgsError} naming the flag and the choices.
 *
 * @typedef {{ options: Record<string, string | boolean | string[]>, positionals: string[] }} ParsedArgs
 */

export class ArgsError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "ArgsError";
  }
}

/**
 * Parse argv-style arguments into options and positionals.
 *
 * Declared value options with no following argument (or whose next token
 * is another `--flag`) throw {@link ArgsError} naming the flag. Pairs in
 * `schema.conflicts` throw {@link ArgsError} naming both flags when both
 * are present.
 *
 * @param {string[]} argv
 * @param {ArgSchema} schema
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, schema = {}) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const booleanSet = new Set(schema.booleanOptions ?? []);
  const repeatableSet = new Set(schema.repeatableOptions ?? []);
  for (const key of repeatableSet) valueSet.add(key);
  /** @type {Record<string, string | boolean | string[]>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      if (valueSet.has(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new ArgsError(`missing value for --${key}`);
        }
        i += 1;
        if (repeatableSet.has(key)) {
          if (!Array.isArray(options[key])) options[key] = [];
          options[key].push(next);
        } else {
          options[key] = next;
        }
      } else if (booleanSet.has(key)) {
        options[key] = true;
      } else {
        // Unknown flags with a following value that doesn't look like a flag.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }

    i += 1;
  }

  for (const pair of schema.conflicts ?? []) {
    const [a, b] = pair;
    if (options[a] && options[b]) {
      throw new ArgsError(`cannot combine --${a} and --${b}`);
    }
  }

  for (const [key, choices] of Object.entries(schema.valueChoices ?? {})) {
    const value = options[key];
    if (value !== undefined && !choices.includes(String(value))) {
      throw new ArgsError(`invalid value for --${key}: "${value}" (expected ${choices.join("|")})`);
    }
  }

  return { options, positionals };
}

/**
 * Split a raw CLI argument string (as passed by Claude Code's $ARGUMENTS) into
 * an argv-style array, respecting single and double quotes.
 *
 * Backslash is ALWAYS a literal character — there is no escape mechanism, so
 * Windows paths such as `C:\Program Files\shot.png` survive intact whether or
 * not they're quoted. Quotes toggle a "currently quoted" state as usual; to
 * include a literal quote character inside an argument, wrap the argument in
 * the OTHER quote type (e.g. `'say "hi"'` yields the single token `say "hi"`,
 * and `"it's fine"` yields `it's fine`).
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function splitRawArgumentString(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of raw) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Convenience wrapper used by command handlers. Splits a raw argument string
 * and then parses it.
 *
 * @param {string[]} argv
 * @param {ArgSchema} schema
 * @returns {ParsedArgs}
 */
export function parseCommandInput(argv, schema = {}) {
  const normalizedArgv = argv.flatMap((arg) => {
    if (!arg || typeof arg !== "string") {
      return [];
    }

    // A lone token with no whitespace has nothing to split (no quotes, no
    // spaces to tokenize) — skip splitRawArgumentString entirely rather than
    // walking it character by character for no reason.
    const hasRawOptionBoundary = /\s/.test(arg) && /(^|\s)--\S/.test(arg);
    if ((argv.length === 1 && /\s/.test(arg)) || hasRawOptionBoundary) {
      return splitRawArgumentString(arg);
    }

    return [arg];
  });
  return parseArgs(normalizedArgv, schema);
}

/**
 * Parse command argv. On {@link ArgsError}, write the message to stderr
 * (prefixed with `antigravity:<command> — ` when `command` is set) and
 * return null so the caller can `return 1`.
 *
 * @param {string[]} argv
 * @param {ArgSchema} schema
 * @param {string} [command]
 * @returns {ParsedArgs | null}
 */
export function readCommandInput(argv, schema = {}, command = "") {
  try {
    return parseCommandInput(argv, schema);
  } catch (err) {
    if (err instanceof ArgsError) {
      const prefix = command ? `antigravity:${command} — ` : "";
      process.stderr.write(`${prefix}${err.message}\n`);
      return null;
    }
    throw err;
  }
}
