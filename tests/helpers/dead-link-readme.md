# Dead-link fixture

`tests/check-pack.test.mjs` reads this file as a README. It is not shipped:
`tests/` is outside the `files` list in `package.json`.

- A link to a markdown file that is not on disk:
  [missing](./missing-doc.md)
- A link that resolves inside the package: [contract](../../docs/COMPATIBILITY.md)
- A link that escapes the package root: [outside](../../../outside-of-package.md)
