# Testing: shopify-bulk-editor

## Strategy

The safety guarantees live in pure logic, so that logic gets dense unit coverage; Shopify integration behavior (OAuth, embedding, webhooks, real mutations) is verified manually against a development store per the phase checklists. No network calls in automated tests.

### Unit tests (Vitest)

The load-bearing modules, all pure or mockable at the boundary:

- `lib/filters.ts` — filter object to Shopify query string: each field, combinations, quoting/escaping of values with spaces and quotes.
- `lib/edit-set.ts` — operation validation (every rule in the table in `docs/api-contracts.md`); after-value computation: percent/amount price math, half-up rounding to 2 decimals, negative-result flagging, tag add/remove deltas (including add-existing and remove-absent), unchanged detection.
- `lib/csv.server.ts` — export serialization (quoting, tag joining, formula-injection escaping); import parsing/validation: every error case with exact `row N, column X` messages, cross-row product-level conflicts, unknown-column warnings, row cap.
- `lib/undo.ts` — inverse-item computation: price/status/metafield restore, tag delta inversion, applied-items-only.
- `worker/throttle.server.ts` — pacing math from cost extensions: wait computation, estimate updates, no-wait when budget suffices.
- `lib/errors.ts` and webhook topic dispatch mapping.

### Integration tests (Vitest, real SQLite, mocked admin client)

- Worker lifecycle: claim `queued` job, process items, counts add up, terminal status correct for full success / partial failure / infra failure.
- Guarded status transitions: double-apply and apply-from-wrong-state rejected.
- Resume: job with `applied` and `pending` items resumes without touching `applied` ones.
- Stale-skip: mocked live read differing from `beforeJson` yields `skipped_stale`.
- Undo eligibility: latest-job-only, already-undone rejection.

Mock the Shopify `admin.graphql` client at the call boundary with canned responses (including `userErrors` and `extensions.cost`); use a throwaway SQLite file per test run. Do not mock Prisma.

### Manual QA

- Follow the per-phase Manual test checklists and the Phase verification list in `docs/phases.md` on a real development store via `npm run dev` (Shopify CLI).
- Inspect `Job`/`JobItem`/`SavedFilter` rows with `npx prisma studio`.
- Trigger webhooks with `shopify app webhook trigger`, including `app/uninstalled` and `bulk_operations/finish`.
- Exercise the bulk paths at realistic scale at least once per phase: a 500+ item apply and a 1,000+ product export.

## Exact commands

```
npm run lint        # ESLint (Shopify flat config)
npm run typecheck   # tsc --noEmit
npm run test        # Vitest, run once (CI mode)
npm run build       # remix vite:build
```

Database setup for tests and local runs:

```
npx prisma generate         # regenerate client after schema changes
npx prisma migrate deploy   # apply committed migrations
```

## Definition of "done" gate

A feature is not done until, on the feature branch:

- `npm run lint`, `npm run typecheck`, `npm run test` pass and `npm run build` succeeds.
- The feature's manual checklist items in `docs/phases.md` are checked.

After creating or editing files, run build and tests and fix all errors before reporting done. Never report done on a red build.
