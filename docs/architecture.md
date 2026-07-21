# Architecture: shopify-bulk-editor

Follows the conventions of `shopify-remix-starter` (same auth, session storage, webhook, Polaris, and Prisma patterns). This document covers what is different: the job engine, the bulk-machinery choices, and the safety model.

## App flow

1. **Install / OAuth** — `@shopify/shopify-app-remix` handles the OAuth handshake and persists the session via the Prisma session storage adapter, exactly as in the starter. Scopes: `read_products,write_products`.
2. **Embedded app** — Runs inside Shopify Admin behind App Bridge; every `app.*` route authenticates with `authenticate.admin(request)`. All UI is Polaris.
3. **Browse** — The product browser compiles the merchant's filters into a Shopify product search query string and pages through `products(query: ...)` on the Admin GraphQL API. Saved filters persist per shop in the database.
4. **Stage** — "Bulk edit" creates a `Job` in `draft` status carrying the selection (explicit product IDs or a filter). The builder attaches validated operations and moves the job to `staging`; the worker fetches every targeted product, snapshots the fields the edit touches (before-values), computes absolute after-values, and writes one `JobItem` per product. The job becomes `staged` and the preview screen renders the items.
5. **Apply** — An explicit apply action moves `staged → queued`. The worker processes items one product at a time with cost-aware throttling, re-checking each item's live value against its snapshot before writing. Per-item outcomes (`applied`, `failed`, `skipped_stale`, `skipped_unchanged`) and counts accumulate on the job; the UI polls the job loader until a terminal status.
6. **Export** — An export job starts a `bulkOperationRunQuery` bulk operation. Completion arrives via the `bulk_operations/finish` webhook; a polling fallback covers missed webhooks. The worker downloads the JSONL result, converts it to CSV on local disk, and the job screen serves the download.
7. **Import** — An uploaded CSV is parsed and validated row by row. Valid rows are diffed against live store values and staged as a normal job (same preview, same apply path); invalid rows become flagged items with `row N, column X` messages. A SHA-256 file hash detects re-uploads of an already-applied file.
8. **Undo** — Undo on the most recent applied job computes inverse items from stored before-values and creates a new staged job, which goes through the standard preview and apply flow.
9. **Webhooks** — Single HMAC-verified endpoint: `app/uninstalled` (session cleanup), `app/scopes_update`, the three compliance topics, and `bulk_operations/finish`.

## Decision: throttled sequential mutations, not bulkOperationRunMutation

For applies, the worker runs ordinary Admin GraphQL mutations sequentially, paced by the API's cost feedback, instead of `bulkOperationRunMutation` with a staged JSONL upload. Reasons:

- **Per-item results are the product.** Partial-failure reporting, before-value capture, stale-value checks, and resumability all require handling one product at a time. `bulkOperationRunMutation` returns a single result JSONL only after the whole operation finishes, which forces post-hoc parsing to reconstruct per-item outcomes and cannot skip a stale item at write time.
- **Mutation shape.** `bulkOperationRunMutation` requires a mutation taking a single input variable per JSONL line. `tagsAdd`/`tagsRemove` (id + tags) and `productVariantsBulkUpdate` (productId + variants) do not fit that shape without wrapper compromises; sequential calls use each mutation's natural form.
- **Scale fits.** Target stores have up to a few thousand products (job cap: 5,000 items). At roughly 10 cost points per mutation against a 50–100 points/second restore rate, a 1,000-item job completes in a few minutes — acceptable for a supervised background job with live progress.
- **Simplicity.** No staged upload lifecycle, no result-file parsing, no contention for the shop's single concurrent bulk-mutation slot.

The trade-off is throughput: very large catalogs (tens of thousands of products) would favor `bulkOperationRunMutation`. That is out of scope and recorded as a known limit.

Bulk machinery is still used where it fits: **export uses `bulkOperationRunQuery`**, which is the correct tool for reading an unbounded product set without pagination cost, and its completion is event-driven.

### Export completion detection

- Primary: the `bulk_operations/finish` webhook. The payload carries `admin_graphql_api_id` and `status`; the handler looks up the export job by `bulkOperationGid`, queries the `BulkOperation` node for its result `url`, downloads the JSONL, converts to CSV, and marks the job complete.
- Fallback: the worker polls the `BulkOperation` node for every export job in `running` status every 15 seconds. Webhook and poller race safely — completion is guarded by a status transition (`running → completed` happens once; the loser sees a non-running job and does nothing).

### Cost-aware throttling

Every Admin GraphQL response includes `extensions.cost` (`actualQueryCost`, `throttleStatus.currentlyAvailable`, `throttleStatus.restoreRate`). The worker tracks the last observed throttle status per shop; before each call it estimates the next cost from the last actual cost of the same operation (default 50 points until observed) and, if `currentlyAvailable` is insufficient, sleeps `(needed - available) / restoreRate` seconds. One worker processes one job at a time, so there is no internal contention. A `THROTTLED` GraphQL error, if it still occurs, retries the item once after the computed wait, then marks the item failed.

## Decision: DB-backed job table with an in-process worker

Background work uses a `Job`/`JobItem` table in the app database and a single worker loop inside the Remix server process (module-level singleton, started once, guarded against Vite HMR re-instantiation the same way as the Prisma client). No Redis, no queue library.

- Job volume is tiny (a merchant runs jobs occasionally); a 1-second poll on an indexed `status` column is negligible load.
- The database is already the source of truth for items and results; adding a queue would duplicate state and add a deployment dependency for no gain at this scale.
- Recovery is data-driven: the worker heartbeats `heartbeatAt` on its running job. On boot (and periodically), jobs in `running` with a heartbeat older than 2 minutes are re-claimed and resumed; items already `applied` are never re-processed, and because after-values are absolute, an accidental re-apply of a completed item writes the same value.

Constraint: exactly one app instance in production (the worker is in-process and jobs are claimed without cross-instance locking). Recorded in the launch checklist.

## Folder and file tree

```
shopify-bulk-editor/
  app/
    entry.server.tsx              Remix server entry (embedding headers, worker bootstrap)
    root.tsx                      App Bridge + Polaris AppProvider, ErrorBoundary
    routes/
      _index/
        route.tsx                 Non-embedded landing/redirect
      auth.$.tsx                  OAuth begin/callback catch-all
      auth.login/
        route.tsx                 Non-embedded OAuth start form
      webhooks.tsx                HMAC verify + topic dispatch (incl. bulk_operations/finish)
      app.tsx                     Embedded layout: authenticate.admin, NavMenu
      app._index.tsx              Product browser: filters, saved filters, selection,
                                  actions to start a bulk edit or an export
      app.edits.new.tsx           Action-only: create a draft job from a selection
      app.edits.$id.tsx           Edit flow by job status: builder (draft),
                                  staging progress, before/after preview (staged),
                                  apply / discard actions
      app.import.tsx              CSV upload + validation -> staged import job
      app.jobs._index.tsx         Job history list
      app.jobs.$id.tsx            Job detail: live progress, per-item results, undo/cancel
      app.jobs.$id.download.tsx   Resource route streaming a finished export CSV
    shopify.server.ts             shopifyApp() config: scopes, session storage, webhooks
    db.server.ts                  Prisma client singleton
    lib/
      logger.server.ts            Structured JSON-lines logger
      errors.ts                   Shared error shape + helpers
      filters.ts                  Filter object <-> Shopify search query string (pure)
      edit-set.ts                 Operation validation + after-value computation (pure)
      undo.ts                     Inverse-edit computation from before/after (pure)
      csv.server.ts               CSV export serialization, import parsing + validation
    worker/
      worker.server.ts            Singleton loop: claim jobs, heartbeat, crash recovery
      stage.server.ts             Staging: fetch targets, snapshot before, compute after
      apply.server.ts             Apply: stale check, mutation dispatch, item outcomes
      export.server.ts            Bulk query start, node polling, JSONL -> CSV
      throttle.server.ts          Cost-aware pacing from extensions.cost (pure core)
  prisma/
    schema.prisma
    migrations/                   Generated; never hand-edited after applying
    dev.sqlite                    Local dev DB (gitignored)
  storage/
    exports/                      Generated export CSVs (gitignored)
  docs/
  public/
  .env.example
  package.json / package-lock.json
  tsconfig.json / vite.config.ts / vitest.config.ts
  shopify.app.toml
  eslint.config.js / .prettierrc
```

## Tech stack with rationale

Same core stack as `shopify-remix-starter`; exact versions are pinned at install time and the lockfile is committed.

- **Remix 2 (Vite 6) + TypeScript 5** — Loader/action model fits Shopify's per-request auth; the official Shopify package targets it. Vite 6 is the ceiling: `@remix-run/dev` 2.17.5 declares `vite: "^5.1.0 || ^6.0.0"`, so Vite 7+ is out of range until the app moves to React Router 7.
- **@shopify/shopify-app-remix 4** — OAuth, session token validation, webhook verification/registration. No hand-rolled auth.
- **@shopify/polaris 13 + @shopify/app-bridge-react 4** — Native Admin look, embedded framing, navigation, toasts. No other UI framework.
- **Prisma 6 + SQLite (dev) / Postgres (prod)** — First-class session adapter; the job tables need nothing beyond a relational store. Same schema in both environments via `DATABASE_URL`.
- **csv-parse 5 / csv-stringify 6** — Battle-tested streaming CSV handling with correct quoting/escaping semantics; hand-rolling CSV parsing is a known bug farm. Only new runtime dependencies beyond the starter set.
- **Vitest 3** — Unit tests for the pure logic that carries the safety guarantees (price math, validation, diffing, inverse edits, throttle pacing).
- **No queue/worker library** — Justified above.
- **Node 20 LTS, Shopify CLI for dev tunneling** — As in the starter.

### Pinned transitive dependencies

`package.json` carries an `overrides` block (`tar`, `esbuild`, `estree-util-value-to-estree`,
`vite`). These are build-time transitives of `@remix-run/dev` that ship known-vulnerable versions
its manifest still allows; the overrides force patched releases. All four are dev/build scope and
none is reachable from the running server. Revisit the block on any Remix upgrade — if the upstream
ranges move past the pinned versions, drop the entry rather than carrying a stale pin.

`turbo-stream` is deliberately **not** overridden. It is a runtime dependency of `@remix-run/react`
and `@remix-run/server-runtime`, and its patched 3.x line is API-incompatible with Remix 2 single
fetch (`decode()` returns the payload directly instead of `{ done, value }`, and the streams are
strings rather than bytes). Forcing it silently breaks every loader response while the unit suite
still passes. The upstream fix is React Router 7.14+, which is a framework migration, not a bump.

## Data model (Prisma)

SQLite does not support Prisma enums, so status/type fields are strings with allowed values enforced in code and documented here.

```prisma
// Required by the Prisma session storage adapter; fields must not be renamed.
model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
}

model SavedFilter {
  id         String   @id @default(cuid())
  shop       String
  name       String
  filterJson String   // serialized filter object (see api-contracts.md)
  createdAt  DateTime @default(now())

  @@unique([shop, name])
}

model Job {
  id               String    @id @default(cuid())
  shop             String
  type             String    // edit | csv_import | export | undo
  status           String    // draft | staging | staged | queued | running |
                             // completed | completed_with_errors | failed |
                             // canceled | discarded
  editSetJson      String?   // operations (edit/csv_import); null for export/undo
  selectionJson    String?   // { mode: "explicit"|"filter", ... } (edit/export)
  totalItems       Int       @default(0)
  processedCount   Int       @default(0)
  successCount     Int       @default(0)
  failedCount      Int       @default(0)
  skippedCount     Int       @default(0)
  errorCode        String?   // job-level failure code
  errorMessage     String?
  fileName         String?   // csv_import: original upload name
  fileHash         String?   // csv_import: sha256 of upload, for duplicate detection
  bulkOperationGid String?   // export: gid://shopify/BulkOperation/...
  resultPath       String?   // export: path under storage/exports/
  undoOfJobId      String?   @unique  // undo: the job being reversed
  undoneByJobId    String?   // set on the original when its undo completes
  heartbeatAt      DateTime?
  createdAt        DateTime  @default(now())
  startedAt        DateTime?
  finishedAt       DateTime?
  items            JobItem[]

  @@index([shop, status])
  @@index([shop, createdAt])
}

model JobItem {
  id           String  @id @default(cuid())
  jobId        String
  job          Job     @relation(fields: [jobId], references: [id])
  productGid   String
  productTitle String  // denormalized so results render after product deletion
  csvRow       Int?    // csv_import: 1-based data row in the uploaded file
  beforeJson   String? // snapshot of only the fields this edit touches
  afterJson    String? // absolute target values, resolved at staging time
  status       String  // pending | applied | failed | skipped_stale |
                       // skipped_unchanged | invalid
  message      String? // failure/skip reason or validation error

  @@index([jobId, status])
}
```

Relationships: `Job 1—N JobItem`. `Job.undoOfJobId` points an undo job at its original; `Job.undoneByJobId` is the back-reference set when the undo completes, which is what disables a second undo. Everything is keyed by `shop`; no cross-shop reads exist.

### Job lifecycle

```
edit:        draft -> staging -> staged -> queued -> running -> completed
                                   |                        \-> completed_with_errors
                                   \-> discarded              \-> failed
csv_import:  staging -> staged -> (same as edit from staged)
undo:        staging -> staged -> (same as edit from staged)
export:      queued -> running -> completed | failed
queued/running -> canceled (user cancel; running stops at the next item boundary)
```

### Before/after snapshot shape (JSON in `beforeJson` / `afterJson`)

Only fields the edit set touches are captured. Example for a price + tags edit:

```json
{
  "variants": [{ "id": "gid://shopify/ProductVariant/111", "price": "10.00" }],
  "tags": { "list": ["sale"], "delta": ["clearance"] }
}
```

- **price / status / metafield** — `before` stores the exact prior value; undo restores it. At apply time the live value is re-read: if it no longer matches `before`, the item is `skipped_stale` (someone changed it since staging).
- **tags** — `delta` records the tags actually added or removed; undo applies the inverse operation (`add` becomes `remove` of the same delta) rather than overwriting the full list, so tags a merchant added in the meantime survive. Tag operations do not stale-skip: add/remove are set operations and merge safely.

## Where state lives

- **Session/auth** — `Session` table via the Prisma adapter. No in-memory session cache.
- **Jobs, items, saved filters** — Database, keyed by shop. This is the app's only durable feature state.
- **Product data of record** — Shopify, always. Before-values are point-in-time snapshots for preview/undo, never a mirror; the browser and staging always read live data.
- **Export files** — Local disk under `storage/exports/<jobId>.csv`, path recorded on the job; cleaned up after 7 days. Production requires a persistent disk (launch checklist).
- **UI/request state** — Remix loaders/actions per request. Progress screens poll their own loader; no client-side global store.
- **Worker state** — None beyond the database. The loop keeps no in-memory queue; a restart loses nothing.

## External dependencies

- **Shopify Admin GraphQL API** — All product reads/writes; bulk operation for export. API version pinned in `shopify.server.ts` and upgraded deliberately.
- **Shopify OAuth + webhooks** — Via `@shopify/shopify-app-remix`.
- **Shopify bulk operation result storage** — The JSONL result `url` returned on the `BulkOperation` node (time-limited download; fetched server-side by the worker).
- **Shopify CLI tunneling** — Local development only.
- **Database** — SQLite locally; managed Postgres in production.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY` | App Client ID. Public; used by App Bridge and OAuth. |
| `SHOPIFY_API_SECRET` | App Client Secret. Verifies webhook HMAC, exchanges OAuth codes. |
| `SCOPES` | `read_products,write_products` — covers products, variants, and product metafields. |
| `SHOPIFY_APP_URL` | Public HTTPS base URL (tunnel in dev). Builds OAuth and webhook callback URLs. |
| `DATABASE_URL` | Prisma connection string. SQLite file in dev; Postgres in prod. |

All documented with dummy values in `.env.example`. Startup fails fast with a readable error if any is missing.
