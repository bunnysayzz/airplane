// SPDX-License-Identifier: Apache-2.0
# Contributing to Airplane

Thanks for wanting to contribute. Airplane is an open-source offline BLE-mesh
broadcast-feed app. Keep it simple, keep it honest, keep it anonymous.

## Dev setup

Requirements: Node 24 (see `.nvmrc`), npm (bundled with Node).

```bash
nvm use        # installs/loads Node 24
npm install    # install root workspace deps (run once, from the repo root)
```

Day-to-day commands (from the repo root):

```bash
npm test             # run the whole jest suite (packages/protocol, storage, mesh-sim)
npm run typecheck    # strict tsc --noEmit per package/workspace
npm run lint         # eslint, zero warnings allowed
npm run format       # prettier --write .
```

**Do not commit or push generated or platform directories** (`node_modules`,
`dist`, `android`, `ios`, `.expo`, `coverage`). They are gitignored.

## Commit style

We use conventional commits:

```
feat(protocol): add view-receipt aggregation
fix(storage): handle corrupt SQLite page on cold start
docs: clarify mesh-sim seeding strategy
test(mesh-sim): add partition-healing scenario
```

- `feat` / `fix` / `docs` / `test` / `refactor` / `chore` — pick the right one.
- Scope in parentheses is the workspace or package (`protocol`, `storage`,
  `mesh-sim`, `mobile`, `root`).
- Imperative mood, lowercase, no trailing period. Keep the subject under 72 chars.

## Pull request bar

A PR merges when all of this holds:

1. **CI is green** — typecheck, tests, lint, format all pass.
2. **Unit tests for pure logic** — any new logic in `packages/` ships with tests.
   No test-only-works-on-my-phone handwaving; the protocol, storage, and mesh
   sim must be verifiable on a plain laptop.
3. **No `react-native` / `expo` imports in `packages/protocol`** — the protocol
   package must stay pure TypeScript. This is enforced by the
   `no-restricted-imports` rule in `eslint.config.mjs` (CI fails on violation).
   Platform adapters live outside the protocol package.
4. **Spec-first for protocol changes** — if a PR changes the wire format, event
   schema, or ranking rules, the spec under `docs/` is updated in the same PR
   before the code is reviewed.

## Code style

- Every source file starts with `// SPDX-License-Identifier: Apache-2.0`.
- TypeScript `strict` everywhere; no `any` without a comment explaining why.
- Prettier is the formatter of record — run `npm run format` before pushing.

## Security

Found a vulnerability? See `SECURITY.md`. Please do not open a public issue
for a security report.
