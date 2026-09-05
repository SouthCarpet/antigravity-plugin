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
        throw new ArgsError(`unknown flag --${key}; put prompt text after --`);
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

/** Parse tokenized command argv without reinterpreting argument boundaries. */
export function parseCommandInput(argv, schema = {}) {
  return parseArgs(argv, schema);
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
