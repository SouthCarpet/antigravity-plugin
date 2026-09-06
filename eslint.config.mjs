/**
 * Flat ESLint config (076-T6b, item 18): one gate, cyclomatic complexity, so
 * the codebase keeps the user's rule ("all code passes cyclomatic-complexity
 * linting; refactor instead of suppressing warnings") enforced instead of
 * remembered. No style rules, no formatter — this is not a style gate.
 *
 * No `globals` declaration: no rule here reads it (`no-undef` is not
 * enabled), so it was dead weight that also broke the eslint 10 upgrade
 * (`globals` ships only as a transitive dependency on the eslint 9 line).
 */
export default [
  {
    files: ["bin/**/*.{mjs,js,cjs}", "scripts/**/*.{mjs,js,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      complexity: ["error", { max: 20 }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["tests/**/*.{mjs,js,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
