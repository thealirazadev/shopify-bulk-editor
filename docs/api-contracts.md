# API Contracts: shopify-bulk-editor

Every route the app exposes, the webhooks it consumes, the shared JSON shapes, and the Admin GraphQL operations the worker runs. Embedded routes authenticate via Shopify session token (JWT from App Bridge) validated by `authenticate.admin(request)`; webhooks authenticate via HMAC validated by `authenticate.webhook(request)`. This contract is agreed before any code is written.

## Consistent error format

All JSON error responses use one shape:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Percent adjustment must be between -99 and 1000.",
    "requestId": "req_9f2c1a"
  }
}
```

Codes: `UNAUTHENTICATED`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT` (illegal job-state transition, e.g. applying a non-staged job or undoing an already-undone job), `LIMIT_EXCEEDED` (selection or CSV over the 5,000-item cap, upload over 5 MB), `UPSTREAM_ERROR` (Shopify/API failure), `INTERNAL`. `message` is friendly and safe to show; `requestId` correlates with the server log line. Stack traces, GraphQL `userErrors` arrays, and upstream bodies are logged, never returned.

Per-item failures inside a job are **not** errors in this format — they are data (`JobItem.status` + `message`) returned by job loaders, because a partially failed job is a successful HTTP response.

## Shared JSON shapes

### Filter object (`filterJson`, saved filters, browse params)

All fields optional; present fields AND together.

```json
{
  "collectionId": "gid://shopify/Collection/42",
  "vendor": "Acme",
  "tag": "sale",
  "status": "ACTIVE",
  "title": "shirt"
}
```

Compiled by `lib/filters.ts` to a Shopify product search query, e.g.
`collection_id:42 vendor:'Acme' tag:'sale' status:active title:*shirt*`.

### Selection object (`selectionJson`)

```json
{ "mode": "filter", "filter": { "vendor": "Acme" } }
{ "mode": "explicit", "productIds": ["gid://shopify/Product/1", "gid://shopify/Product/2"] }
```

Selections resolving to more than 5,000 products are rejected with `LIMIT_EXCEEDED` at staging.

### Edit set (`editSetJson`)

1–4 operations, at most one per field.

```json
{
  "operations": [
    { "field": "price", "op": "adjust_percent", "value": "10" },
    { "field": "status", "op": "set", "value": "DRAFT" },
    { "field": "tags", "op": "add", "value": "clearance" },
    { "field": "metafield", "op": "set", "namespace": "custom", "key": "badge",
      "type": "single_line_text_field", "value": "New" }
  ]
}
```

Server-side validation (`lib/edit-set.ts`):

| Field | Ops | Value rules |
| --- | --- | --- |
| `price` | `set`, `adjust_percent`, `adjust_amount` | `set`: decimal ≥ 0. `adjust_percent`: -99 to 1000. `adjust_amount`: any decimal; a resulting price < 0 flags the item `invalid`. Results round half-up to 2 decimals. |
| `status` | `set` | One of `ACTIVE`, `DRAFT`, `ARCHIVED`. |
| `tags` | `add`, `remove` | 1–255 chars, no commas, trimmed, non-empty. |
| `metafield` | `set` | namespace/key: `[A-Za-z0-9_-]`, 2–64 chars. `type` one of `single_line_text_field`, `number_integer`, `number_decimal`, `boolean`; value must parse as that type. |

### Job summary (returned by every job loader; the polling shape)

```json
{
  "job": {
    "id": "cjld2cjxh0000qzrm",
    "type": "edit",
    "status": "running",
    "totalItems": 240,
    "processedCount": 120,
    "successCount": 118,
    "failedCount": 1,
    "skippedCount": 1,
    "fileName": null,
    "undoOfJobId": null,
    "undoneByJobId": null,
    "createdAt": "2026-07-18T10:00:00Z",
    "startedAt": "2026-07-18T10:00:05Z",
    "finishedAt": null
  }
}
```

The UI polls by revalidating the route loader every 2 seconds while `status` is `staging`, `queued`, or `running`.

### Job item (preview rows and results)

```json
{
  "id": "itm_1",
  "productGid": "gid://shopify/Product/1",
  "productTitle": "Blue Shirt",
  "csvRow": 7,
  "before": { "variants": [{ "id": "gid://shopify/ProductVariant/11", "price": "10.00" }] },
  "after":  { "variants": [{ "id": "gid://shopify/ProductVariant/11", "price": "11.00" }] },
  "status": "pending",
  "message": null
}
```

Item statuses: `pending`, `applied`, `failed`, `skipped_stale` ("value changed since preview"), `skipped_unchanged` ("already has the target value"), `invalid` (failed staging/CSV validation; never applied).

## OAuth routes

Identical to shopify-remix-starter: `GET|POST /auth/*` (`auth.$.tsx`) delegates OAuth begin/callback to the Shopify package; `GET|POST /auth/login` is the non-embedded shop-domain form. No app-specific behavior.

## Embedded routes

All routes below require `authenticate.admin(request)`; unauthenticated requests redirect into OAuth. Every job/filter read and write is additionally scoped to the authenticated `session.shop` — a job ID belonging to another shop returns `NOT_FOUND`.

### `GET /app` — `app.tsx` layout
Loader returns `apiKey` for App Bridge and nav items (Products, Jobs, Import).

### `GET /app` — `app._index.tsx` product browser
- **Query params:** filter fields (`collectionId`, `vendor`, `tag`, `status`, `title`), `cursor` (pagination), `savedFilterId`.
- **Returns:**

```json
{
  "products": [
    { "id": "gid://shopify/Product/1", "title": "Blue Shirt", "status": "ACTIVE",
      "vendor": "Acme", "tags": ["sale"], "totalVariants": 3, "priceRange": "10.00 - 14.00" }
  ],
  "pageInfo": { "hasNextPage": true, "endCursor": "abc" },
  "savedFilters": [{ "id": "sf_1", "name": "Acme active", "filter": { "vendor": "Acme", "status": "ACTIVE" } }],
  "collections": [{ "id": "gid://shopify/Collection/42", "title": "Summer" }]
}
```

### `POST /app` — `app._index.tsx` actions
Discriminated by `intent` form field:
- `saveFilter` — `name` (1–50 chars, unique per shop) + current filter. Returns `{ "ok": true, "savedFilter": { ... } }`. Duplicate name: `INVALID_INPUT`.
- `deleteFilter` — `savedFilterId`. Returns `{ "ok": true }`.
- `startExport` — current filter object. Creates an `export` job (`queued`), starts the bulk query. Returns `{ "ok": true, "jobId": "..." }`; UI shows a toast linking to the job.

### `POST /app/edits/new` — `app.edits.new.tsx` (action only)
- **Input:** `selectionJson`.
- **Behavior:** Validates the selection, creates a `Job` (`type: "edit"`, `status: "draft"`).
- **Success:** Redirect to `/app/edits/:id`.
- **Errors:** `INVALID_INPUT` (empty selection), `LIMIT_EXCEEDED`.

### `GET /app/edits/:id` — `app.edits.$id.tsx`
Renders by job status: `draft` → edit-set builder; `staging` → progress (polls); `staged` → before/after preview with item pagination (`?page=`, 50 items/page, `?itemStatus=` filter); any applied/terminal status → redirect to `/app/jobs/:id`.
- **Returns:** job summary + `items` page + `counts` per item status. For `csv_import` jobs the preview also includes `invalid` items with their `csvRow` and message, and `duplicateOfJobId` when the file hash matches a previously applied import.

### `POST /app/edits/:id` — intents
- `stage` — `editSetJson`. Valid only from `draft` or `staged` (re-stage after changing operations). Validates operations, sets `staging`, worker takes over. Returns `{ "ok": true }`.
- `apply` — Valid only from `staged`. Transitions to `queued`. Returns `{ "ok": true }`. Double-submit is safe: the second request hits a non-`staged` job and gets `CONFLICT`.
- `discard` — Valid from `draft`/`staged`. Sets `discarded`. Returns `{ "ok": true }`.

### `GET /app/import` / `POST /app/import` — `app.import.tsx`
- **GET:** upload form plus the CSV column reference.
- **POST:** multipart form, field `file`. Limits: 5 MB, `.csv`, 5,000 data rows (`LIMIT_EXCEEDED` otherwise).
- **Behavior:** Parses and validates every row (see CSV contract below); creates a `csv_import` job in `staging` (worker diffs valid rows against live values). Redirects to `/app/edits/:id` for the dry-run preview. A file whose SHA-256 matches an applied import for this shop still stages, but the preview shows a duplicate warning.
- **Errors:** `INVALID_INPUT` (not CSV, missing required columns, zero data rows) with a message naming the problem.

### `GET /app/jobs` — `app.jobs._index.tsx`
- **Query params:** `cursor`.
- **Returns:** `{ "jobs": [ <job summary>, ... ], "pageInfo": { ... } }`, newest first, this shop only.

### `GET /app/jobs/:id` — `app.jobs.$id.tsx`
- **Returns:** job summary + paginated items (`?page=`, `?itemStatus=`) + `canUndo` (true only when this is the shop's most recent `completed`/`completed_with_errors` job of type `edit` or `csv_import` and `undoneByJobId` is null) + `canCancel` (status `queued` or `running`) + `downloadReady` (export with `resultPath` set).

### `POST /app/jobs/:id` — intents
- `undo` — Valid only when `canUndo`. Creates a new `Job` (`type: "undo"`, `undoOfJobId: :id`, `status: "staging"`); items are computed from the original's `applied` items with before/after inverted. Redirects to `/app/edits/:newId` for preview. Errors: `CONFLICT` with a reason (`"A newer job has been applied"`, `"This job was already undone"`).
- `cancel` — Valid from `queued`/`running`. Sets `canceled`; a running worker stops at the next item boundary (already-applied items stay applied and remain undoable). Returns `{ "ok": true }`.

### `GET /app/jobs/:id/download` — `app.jobs.$id.download.tsx`
Streams the export CSV (`Content-Type: text/csv`, attachment filename `products-export-<jobId>.csv`). `NOT_FOUND` until `resultPath` is set or after the 7-day retention cleanup.

## Webhook route

### `POST /webhooks` — `webhooks.tsx`
HMAC via `authenticate.webhook(request)`; invalid HMAC → `401`, logged. Unknown topics → `200`, logged at `warn`. Handler failures that should be retried → `500`.

| Topic | Purpose | Handler action |
| --- | --- | --- |
| `APP_UNINSTALLED` | Shop removed the app | Delete the shop's `Session` rows; cancel its `queued`/`running` jobs. |
| `APP_SCOPES_UPDATE` | Granted scopes changed | Update stored session scope. |
| `BULK_OPERATIONS_FINISH` | Bulk operation (export) completed or failed | Look up the job by `admin_graphql_api_id`; on `completed`, fetch the node's `url`, download JSONL, write CSV, mark job `completed`; on failure, mark `failed` with `errorCode`. Idempotent: a job no longer `running` is left untouched. |
| `CUSTOMERS_DATA_REQUEST` | GDPR data request | Log and acknowledge; no customer data stored. |
| `CUSTOMERS_REDACT` | GDPR delete customer | Log and acknowledge; no customer data stored. |
| `SHOP_REDACT` | GDPR delete shop (48h after uninstall) | Delete the shop's `SavedFilter`, `Job`, `JobItem` rows and export files. |

### Example payload — `bulk_operations/finish`

```json
{
  "admin_graphql_api_id": "gid://shopify/BulkOperation/123456",
  "completed_at": "2026-07-18T10:02:11Z",
  "created_at": "2026-07-18T10:00:03Z",
  "error_code": null,
  "status": "completed",
  "type": "query"
}
```

Note: the payload has no result URL; the handler must query the `BulkOperation` node for `url`.

## CSV contract

### Export columns (one row per variant; product fields repeat per variant)

```
product_id,variant_id,handle,product_title,variant_title,vendor,status,tags,price
gid://shopify/Product/1,gid://shopify/ProductVariant/11,blue-shirt,Blue Shirt,Small,Acme,ACTIVE,"sale, summer",10.00
```

Formula-injection guard: any cell that would start with `=`, `+`, `-`, or `@` is prefixed with `'` on export.

### Import rules

- Required columns: `product_id`, `variant_id`. Editable columns: `price` (per variant row), `status`, `tags` (product-level; full replacement list, comma-separated inside the quoted cell). Unknown columns are ignored and reported as a warning naming them. Metafields are not CSV-editable in v1.
- Product-level values must agree across a product's variant rows; a mismatch is an error on the later row (`row 9, column status: conflicts with row 7`).
- Row errors never abort the file: each invalid row becomes an `invalid` item with `csvRow` and a message like `row 7, column price: "1O.OO" is not a valid amount`; valid rows stage normally.
- Idempotency: values are absolute, staging diffs against live data (rows already matching become `skipped_unchanged`), and the file hash flags re-imports of an applied file. Re-applying therefore never compounds a change.

## Admin GraphQL operations

Representative operations the app runs (API version pinned in `shopify.server.ts`). Every mutation response's `userErrors` is checked; a non-empty array marks that item `failed` with the first message, full array logged.

### Browse: `ProductsPage`

```graphql
query ProductsPage($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: TITLE) {
    edges {
      node {
        id title handle status vendor tags
        variantsCount { count }
        priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

### Staging read: `StageProducts` (paged over the selection; also the per-item stale-check read with `first: 1` and an ID query)

```graphql
query StageProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query) {
    edges {
      node {
        id title status tags
        variants(first: 100) { edges { node { id title price } } }
        metafield(namespace: "custom", key: "badge") { id value type }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

(The `metafield` field is included only when the edit set touches a metafield, with the namespace/key from the operation.)

### Export: `StartExport` and `BulkOpStatus` (polling fallback)

```graphql
mutation StartExport($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}

query BulkOpStatus($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url }
  }
}
```

`bulkOperationRunQuery` returning a `userError` because another bulk query is already running marks the export `failed` with a friendly "another export is in progress" message.

### Apply mutations (one product per call, sequential, throttled)

```graphql
mutation UpdateStatus($input: ProductInput!) {
  productUpdate(input: $input) { product { id status } userErrors { field message } }
}

mutation AddTags($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}

mutation RemoveTags($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
}

mutation UpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}

mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message }
  }
}
```

An edit set touching multiple fields runs the needed mutations for one product before moving to the next; if any mutation for a product fails, the item is `failed` with the field named in the message, and mutations already applied for that product are recorded in the item's message (no automatic per-item rollback — the job-level undo covers reversal).
