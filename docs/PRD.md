# Product Requirements: shopify-bulk-editor

## What we're building

An embedded Shopify admin app that lets a merchant change many products at once without fear. The merchant filters products (collection, vendor, tag, status, title match), stages an edit set (for example "price +10%" plus "tag add clearance"), and sees a per-product before/after preview of exactly what will change. Nothing is written until the merchant explicitly applies the staged preview; the apply runs as a tracked background job with per-item results, every applied job stores the before-values it overwrote so it can be undone, and the whole flow round-trips through CSV for merchants who prefer editing in a spreadsheet.

## Target user

Merchants and store operators on stores with hundreds to a few thousand products who need recurring bulk changes (seasonal repricing, clearance tagging, status sweeps, metafield backfills) and cannot risk Shopify's native bulk editor's lack of preview, partial-failure visibility, and undo. Secondary user: agencies making the same class of change across client stores. They are not developers; every destructive action must be previewable, reportable, and reversible.

## Core features (prioritized)

### 1. Product browser with filters and saved filters
A Polaris index table of products filterable by collection, vendor, tag, status, and title match (filters combine with AND). Row selection (explicit rows or "all matching filter") feeds every other feature. Filter combinations can be saved per shop under a name and re-applied with one click.

### 2. Edit set builder with staged preview
The merchant composes an edit set of one or more operations: price set / adjust by percent / adjust by amount (variant-level), status set (ACTIVE, DRAFT, ARCHIVED), tags add / remove, metafield set (namespace, key, supported type, value). Staging computes a per-product before/after row for every targeted product, resolving relative adjustments ("+10%") to absolute target values at staging time. The preview is a hard gate: no write path exists that skips it.

### 3. Apply as a tracked background job
Applying a staged preview enqueues a job processed by a background worker using throttled, cost-aware sequential Admin GraphQL mutations. The merchant watches live progress (processed / succeeded / failed / skipped). Failures are reported per item with the product and the reason; a partial failure never silently discards the rest of the job and never masquerades as full success. Every applied item persists the before-values it overwrote.

### 4. CSV export
Export the currently filtered products to CSV (one row per variant) using a Shopify bulk operation query. Completion is detected via the `bulk_operations/finish` webhook with a polling fallback, then the result is converted to CSV and offered for download from the job screen.

### 5. CSV import with validation and dry-run preview
Re-import an edited CSV. Every row is validated with precise `row N, column X` error messages (unknown IDs, malformed prices, invalid status, tag rules). Valid rows become a staged job that goes through the same before/after preview as a UI edit — the import is a dry run until the merchant applies it. Re-importing an already-applied file warns via file hash, and because rows carry absolute values and unchanged rows are skipped, re-applying never compounds an adjustment.

### 6. Job history with per-item results
A per-shop list of all jobs (edits, imports, exports, undos) with status and counts. The job detail screen shows every item's outcome — applied, failed with reason, skipped with reason — filterable by outcome.

### 7. Undo the last applied job
The most recent applied edit or import job can be undone. The undo is computed from the stored before-values (inverse operation for tags, before-value restore for price/status/metafield), presented as its own staged preview, and applied as a normal job. Items whose live value changed since the original apply are skipped and reported, never blindly overwritten.

## Non-goals

- No editing of orders, customers, inventory, collections, images, or SEO fields.
- No App Store billing or pricing plans.
- No scheduled or recurring edits; every job is started manually.
- No multi-store sync or cross-store operations.
- No metafield columns in CSV v1; metafields are edited through the UI edit set only.
- No multi-currency or price-list editing; prices are the shop's default currency variant price.
- No redo (undoing an undo) and no undo of arbitrary historical jobs — only the most recent applied job.
- No REST Admin API usage; GraphQL only.

## Success criteria per core feature

### Product browser and saved filters
- Each filter (collection, vendor, tag, status, title) narrows the table to exactly the products Shopify Admin search returns for the equivalent query; combined filters AND together.
- A saved filter survives reload and re-applies its full filter state with one click; deleting it removes it for that shop only.
- Pagination works past 250 products without duplicates or gaps.

### Edit set builder and preview
- Staging "price +10%" over N matched products produces exactly N preview rows whose after-values equal the arithmetic result rounded to 2 decimals.
- While a preview is on screen and not yet applied, no product in Shopify Admin has changed.
- Invalid operations (negative resulting price, bad metafield value for its type) appear as flagged rows in the preview and are excluded from apply.
- There is no route or action that writes product data from an unstaged request.

### Apply job
- After completion, `succeeded + failed + skipped = total` for every job, and the job never reports plain success when `failed > 0`.
- Each failed item shows the product title and the Shopify `userErrors` message for that item.
- Every applied item has stored before-values retrievable from the job detail.
- Killing the worker mid-job and restarting resumes the job without re-applying already-applied items.
- Sustained applies do not trigger throttling errors; the worker paces itself from the API cost data.

### CSV export
- The exported file's data row count equals the variant count of the filtered set.
- With webhook delivery working, the download appears without user refresh; with the webhook blocked, the polling fallback completes the job within one polling interval.
- Cells that would start with `=`, `+`, `-`, or `@` are escaped so spreadsheets do not execute them.

### CSV import
- A file with a malformed price on row 7 reports exactly "row 7, column price" with a human-readable reason; valid rows in the same file remain importable.
- The import preview shows the same before/after table as a UI edit and applies nothing until confirmed.
- Re-uploading a file whose hash matches an applied import shows a duplicate warning; proceeding anyway yields zero applied items when store values already match (all rows skipped as unchanged).

### Job history
- Every job the shop has run appears with type, status, counts, and timestamps; the detail view filters items by outcome.
- Job history for shop A is never visible to shop B.

### Undo
- Undoing a completed price edit restores each product's exact prior price string; spot checks in Shopify Admin match the stored before-values.
- A product manually changed between apply and undo is skipped with a conflict reason, not overwritten.
- Undo is offered only for the shop's most recent applied edit/import job and only once per job.
