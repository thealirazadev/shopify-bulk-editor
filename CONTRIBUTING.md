# Contributing to shopify-bulk-editor

Thanks for taking the time to contribute. This is an embedded Shopify Admin app that
performs bulk product edits, so the bar for correctness is high: every product write must
stay behind the preview gate, capture before-values, and be reversible. Please read the
design decisions in [`docs/decisions.md`](docs/decisions.md) and the architecture in
[`docs/architecture.md`](docs/architecture.md) before opening a pull request.

## Prerequisites

- Node.js 18.20 or newer (CI runs on Node 24).
- npm (the repository commits `package-lock.json`; use `npm ci` for reproducible installs).

You do **not** need a Shopify store or API credentials to build and test. The Admin GraphQL
API is mocked in the test suite and each integration test writes its own throwaway SQLite
file, so the full gate runs offline. A development store is only required to exercise OAuth,
the embedded UI, webhooks, and live mutations (see [`docs/testing.md`](docs/testing.md)).

## Setup

```
npm ci
npm run prisma:generate
```

`prisma:generate` produces the Prisma client the TypeScript build and tests depend on; run it
after a fresh install and after any change to `prisma/schema.prisma`.

## The gate

Run all four checks before every commit and before opening a pull request. CI runs the same
checks (see `.github/workflows/ci.yml`), using `npm run test:coverage` so the coverage
threshold is enforced, and must stay green.

```
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (Shopify flat config), no warnings
npm run test        # Vitest
npm run build       # remix vite:build
```

Optional: `npm run bench` measures CSV import parse throughput. It is not part of CI and is
not required for a change.

## Making changes

- **One commit per discrete change.** A migration, a model, a route, a component, and its test
  are separate commits. Never bundle a whole feature into one commit. Each commit must leave
  the gate green.
- **Conventional Commits**, lower-case, imperative: `type(scope): subject`. Types: `feat`,
  `fix`, `chore`, `docs`, `refactor`, `test`, `build`. Scopes in use: `auth`, `db`, `app`,
  `products`, `edits`, `jobs`, `export`, `import`, `undo`, `webhooks`, `logging`. No emoji and
  no attribution trailers in commit messages.
- **Add a test whenever behavior changes.** Pure logic (price math, edit-set and CSV
  validation, filter compilation, throttle pacing, inverse-edit computation) is unit tested;
  the worker lifecycle is covered by integration tests against a mocked Admin API. A bug fix
  should come with a test that fails before it.
- **Do not weaken the safety invariants** listed in `docs/decisions.md`: product writes happen only
  in `app/worker/apply.server.ts` from a `queued` job, every applied item captures its
  before-value, status transitions are guarded, and relative adjustments resolve to absolute
  values at staging time.
- **No new dependency** without discussing it first, and pin exact versions (no `^`/`~`).
  Commit the updated `package-lock.json` in the same commit.
- **Schema changes** go through `npx prisma migrate dev --name <change>`. Never edit an applied
  or committed migration; correct mistakes with a new one.

## Pull requests

- Keep the branch focused on one topic. Rebase on the latest `main` before opening.
- Fill in the pull request template: confirm typecheck, lint, test, and build all pass, and
  describe how you verified the change.
- If a change adds scope beyond the current feature set, say so in the description so it can be
  discussed before review.
- Security-sensitive reports should follow [`SECURITY.md`](SECURITY.md) rather than a public
  pull request or issue.

## Reporting bugs and requesting features

Use the issue templates under **New issue**. A good bug report includes the affected commit,
reproduction steps, and expected versus actual behavior.
