# shopify-bulk-editor

[![CI](https://github.com/thealirazadev/shopify-bulk-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/thealirazadev/shopify-bulk-editor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

## Design decisions

The trade-offs worth knowing before reading the code. Fuller rationale in
`docs/architecture.md`.

### Throttled sequential mutations, not `bulkOperationRunMutation`

Applies run ordinary Admin GraphQL mutations one product at a time, paced by the API's
`extensions.cost` feedback, rather than submitting a staged JSONL bulk mutation.

- **Per-item results are the product.** Partial-failure reporting, before-value capture,
  stale-value checks, and resumability all require handling one product at a time.
  `bulkOperationRunMutation` returns a single result JSONL only after the whole operation
  finishes, which forces post-hoc parsing to reconstruct per-item outcomes and cannot skip a
  stale item at write time.
- **Mutation shape.** `bulkOperationRunMutation` requires a mutation taking a single input
  variable per JSONL line. `tagsAdd`/`tagsRemove` (id + tags) and `productVariantsBulkUpdate`
  (productId + variants) do not fit that shape without wrapper compromises.
- **Scale fits.** At roughly 10 cost points per mutation against a 50–100 points/second
  restore rate, a 1,000-item job completes in a few minutes.
- **Cost of the choice:** throughput. Catalogs of tens of thousands of products would favour
  `bulkOperationRunMutation`; that is out of scope and recorded as a known limit.

### Bulk query + finish webhook, with a polling fallback, for export

Export _does_ use bulk machinery: `bulkOperationRunQuery` is the right tool for reading an
unbounded product set without pagination cost. Completion is event-driven through the
`bulk_operations/finish` webhook, and the worker also polls the `BulkOperation` node every 15
seconds for any running export so a missed webhook cannot strand a job. The two race safely —
the `running → completed` transition is guarded, so the loser sees a non-running job and does
nothing.

### A DB-backed job table, not a queue library

Background work is a `Job`/`JobItem` table plus a single in-process worker loop. No Redis, no
queue library.

- Job volume is tiny (a merchant runs jobs occasionally); a 1-second poll on an indexed
  `status` column is negligible load.
- The database is already the source of truth for items and results; a queue would duplicate
  that state and add a deployment dependency for no gain at this scale.
- Recovery is data-driven: the worker heartbeats its running job, and a job whose heartbeat is
  older than 2 minutes is re-claimed and resumed. Already-`applied` items are never
  re-processed, and because after-values are absolute, an accidental re-apply writes the same
  value.

### One app instance in production

The worker is in-process and claims jobs without cross-instance locking, so production must run
exactly one instance. That is the deliberate price of not adding a queue or lock service, and it
is a line item on `docs/launch-checklist.md`.

### Undo is limited to the most recent applied job

Only the shop's most recent `completed` / `completed_with_errors` edit or import job can be
undone, and only once (`undoOfJobId` is unique; `undoneByJobId` closes it). No redo, and no undo
of arbitrary historical jobs — an explicit non-goal in the PRD, because older jobs' before-values
are no longer a truthful picture of the catalog. Undo is not a blind rollback: it is computed
from stored before-values, staged as a normal job behind the same preview gate, and any product
whose live value changed since the apply is skipped and reported rather than overwritten. Tags
invert as set operations (an add becomes a remove of the same delta) instead of overwriting the
whole list, so tags a merchant added in the meantime survive.

### A 5,000-item cap per selection, CSV, or job

Target stores run hundreds to a few thousand products. The cap keeps a sequential, throttled
job's wall-clock time predictable and bounds the preview and result pages.

### CSV v1 carries price, status, and tags only

Metafields are edited through the UI edit set only. Import values are absolute rather than
adjustments, staging diffs them against live data, and a SHA-256 file hash flags a re-import —
so re-applying the same file never compounds a change.

## Benchmark

The CSV import parse + validate path (`parseImportCsv`) is the one hot path measurable without a
live store; every other stage is dominated by Shopify API round trips.

Measured on an Intel Core i5-1235U (12 logical CPUs), 31 GiB RAM, Linux 6.8, Node 24.18.0,
vitest 2.1.8, on an otherwise-idle desktop. Each median is over 25 timed runs after 5 warmup
runs; the ranges span 7 repeats of the whole benchmark.

| Rows            | File size | Parse + validate (median) | Throughput         |
| --------------- | --------- | ------------------------- | ------------------ |
| 1,000           | 138 KB    | 6.5–8.9 ms                | 112k–154k rows/sec |
| 2,500           | 350 KB    | 13.5–21.7 ms              | 115k–186k rows/sec |
| 5,000 (job cap) | 708 KB    | 26.1–41.6 ms              | 120k–191k rows/sec |

Reproduce with `npm run bench`: `benchmark/generate-csv.ts` builds an export-shaped synthetic
file and `benchmark/csv-import.bench.ts` times the real parser. Parsing and validating a
maximum-size import is a sub-50 ms operation, so the 5,000-item cap is set by Shopify API
throughput during apply, not by CSV handling.

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
npm run bench      # CSV parse throughput benchmark (not part of CI)
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
