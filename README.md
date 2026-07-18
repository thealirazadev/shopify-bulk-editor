# shopify-bulk-editor

An embedded Shopify admin app for safe bulk editing of products, variants, and metafields. A merchant
filters products, stages an edit set (set or adjust price, change status, add or remove tags, set a
metafield), previews every before/after value, applies the change as a tracked background job, and can
undo the last applied job. It also round-trips CSV: export filtered products, then re-import an edited
file with row-level validation and a dry-run preview before anything is written.

## Features

- **Product browser** with collection, vendor, tag, status, and title filters (AND-combined), cursor
  pagination, and per-shop saved filters.
- **Edit set builder** — price set / adjust-percent / adjust-amount, status, tag add/remove, and
  metafield set, validated on the server.
- **Staged preview** — a hard gate. Every targeted product shows its before → after values; nothing is
  written until the merchant applies the preview.
- **Tracked apply jobs** — a background worker applies changes one product at a time with cost-aware
  throttling, per-item outcomes (applied / failed / skipped-stale / skipped-unchanged), live progress,
  captured before-values, and crash-safe resume.
- **CSV export** via a Shopify bulk operation, completed by the `bulk_operations/finish` webhook with a
  polling fallback, converted to CSV with a spreadsheet formula-injection guard.
- **CSV import** with precise `row N, column X` validation, a dry-run preview through the same gate,
  and a duplicate-file warning; re-applying an already-applied file changes nothing.
- **Job history** and **undo** of the most recent applied edit or import job.

## Stack

- Remix (Vite) + TypeScript, Shopify App Remix (OAuth, sessions, webhooks)
- Polaris + App Bridge for the embedded UI
- Prisma with SQLite (dev) / Postgres (prod)
- A DB-backed `Job`/`JobItem` table with a single in-process worker (no queue library)
- Shopify Admin GraphQL API; `csv-parse` / `csv-stringify` for the CSV round-trip

Exact versions are pinned in `package.json` and the lockfile is committed.

## Install

```
npm install
cp .env.example .env      # fill in real values from the Partner Dashboard
npx prisma migrate deploy # create the local SQLite schema
```

Required env vars (`.env.example` documents each): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`
(`read_products,write_products`), `SHOPIFY_APP_URL`, `DATABASE_URL`. Startup fails fast if any is
missing.

## Run

```
npm run dev     # Shopify CLI dev + tunnel; install on a development store
npm run build   # production build
npm start       # serve the production build
```

The app requires a development store to install against; OAuth, embedding, webhooks, and live
mutations are verified manually there (see `docs/testing.md`).

## Test

```
npm run lint       # ESLint (Shopify config)
npm run typecheck  # tsc --noEmit
npm run test       # Vitest
```

Automated tests cover the safety-critical pure logic (price math, edit-set and CSV validation, filter
compilation, throttle pacing, inverse-edit computation) and the worker lifecycle (staging, apply with
stale-skip and resume, export completion) against a mocked Admin API and a throwaway SQLite database.

## Operational notes

- Production must run **exactly one app instance**: the worker is in-process and jobs are claimed
  without cross-instance locking.
- `storage/exports/` must be on a persistent disk in production; export files are cleaned up after
  7 days and stale draft/staged jobs after 24 hours.
- See `docs/launch-checklist.md` before shipping.

See `docs/` for the PRD, architecture, API contracts, phases, engineering rules, design, and testing
strategy.
