import globals from "globals";

/**
 * Flat ESLint config (076-T6b, item 18): one gate, cyclomatic complexity, so
 * the codebase keeps the user's rule ("all code passes cyclomatic-complexity
 * linting; refactor instead of suppressing warnings") enforced instead of
 * remembered. No style rules, no formatter — this is not a style gate.
 */
export default [
  {
    files: ["bin/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      complexity: ["error", { max: 20 }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
