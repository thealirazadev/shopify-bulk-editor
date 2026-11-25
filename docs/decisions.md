# Design decisions

## 1. The preview is a hard gate

A bulk edit can only reach the catalog by passing through a staged preview, and the code is
shaped so there is no shortcut. These are the invariants the rest of the app relies on:

- Product mutations exist only in `app/worker/apply.server.ts`, and the worker runs them only
  for a `queued` job. No loader or action writes product data.
- An edit, import, or undo job reaches `queued` only through the apply intent on
  `app.edits.$id.tsx`, a guarded `updateMany` from `staged` to `queued`. Export jobs are created
  `queued` directly because they only read.
- Staging captures `beforeJson` for every item before anything can be applied, so every write
  has a recorded before-value to undo against.
- Relative adjustments (`+10%`, `-2.00`) are resolved to absolute after-values at staging time.
  The apply path writes absolute values only, which makes a resumed or repeated apply write the
  same value instead of compounding the change.

Saved edit-sets follow the same rule: loading one only fills the builder of a `draft` job, the
store module never touches a `Job`, and a test asserts that.

## 2. Throttled sequential mutations instead of `bulkOperationRunMutation`

Applies run ordinary Admin GraphQL mutations one product at a time. Per-item outcomes are the
point of the app: partial-failure reporting, the write-time stale check, and resumability all
need item-at-a-time handling, while `bulkOperationRunMutation` returns a single JSONL result after
the whole run and cannot skip a stale item. Its one-input-per-line shape also does not fit
`tagsAdd`/`tagsRemove` (id plus tags) or `productVariantsBulkUpdate` (product id plus variants).
The cost is throughput, which is acceptable for the target of a few thousand products and is
bounded by the 5,000-item cap on any selection, CSV, or job (`JOB_ITEM_CAP`).

## 3. Pace from the cost block, retry a throttle once

`createThrottler` keeps the last `extensions.cost.throttleStatus` and a per-operation cost
estimate, and `beforeCall` sleeps exactly long enough for the budget to cover the next call. A
zero restore rate short-circuits to no wait, so pacing cannot stall. `runGraphql` originally threw
on any `errors` array, so a transient `THROTTLED` response permanently failed the item. It now
records the cost block from that response and retries once, which lets `beforeCall` wait out the
shortfall; a second throttle or any other error fails the item.

## 4. Re-check the live value before every write

Before mutating, `applyItem` re-reads the product and compares it with the staged before-value.
A difference marks the item `skipped_stale` instead of overwriting a change the merchant made
after previewing. Prices are compared numerically so `10.0` and `10.00` are not a conflict. Tags
are never stale: the apply diffs the before and after tag lists and sends only the added and
removed tags, so tags added by someone else in the meantime survive. A `userErrors` entry fails
the item with its first message and notes which mutations already succeeded for that product.

## 5. A database job table with an in-process worker

Background work is a `Job`/`JobItem` table and one worker loop in the Remix server process, with
no queue library or Redis. Job volume is small, the database already holds items and results, and
a queue would duplicate that state. The worker claims a job with an optimistic update on
`heartbeatAt`, heartbeats while it runs, and re-claims any edit, import, or undo job whose
heartbeat is older than two minutes. Only `pending` items are processed, so a resumed job never
re-applies an applied item. A global flag keeps Vite HMR from starting a second loop in
development. Because claiming has no cross-instance lock, production must run exactly one app
instance.

## 6. Guarded status transitions and counts from items

Every status change is an `updateMany` whose `where` includes the expected current status, so a
double submit, a race between webhook and poller, or a cancel landing mid-run cannot move a job
twice. One race slipped through: the per-item progress increment was an unguarded update, so a
cancel arriving while an item's mutation was in flight could have its counts incremented on top,
and a cancel on the final item left `processedCount` above `totalItems` permanently. The
increment is now guarded on `status: "running"`, and a canceled job's counts are recomputed from
its items, which are the source of truth. The final status is `completed_with_errors` whenever any
item failed, never plain `completed`.

## 7. Export by bulk query, finished by webhook or poll

Export does use bulk machinery: `bulkOperationRunQuery` reads an unbounded product set without
paging cost. Completion is signalled by the `bulk_operations/finish` webhook, and the worker also
polls running exports every 15 seconds so a missed webhook cannot strand a job. Both paths finish
the job through a guarded `running` to `completed` transition, so whichever arrives second sees a
non-running job and does nothing. The JSONL result is converted to CSV on local disk and served
only through the shop-scoped download route.

## 8. Undo swaps snapshots and is limited to the latest job

`computeInverseItems` builds an undo item by swapping an applied item's before and after
snapshots: the undo writes the old before-value and stale-checks against the old after-value. The
undo job is created `staged`, so it goes through the same preview and apply path as any edit.
Only the shop's most recent undoable edit or import can be undone, once (`undoOfJobId` is unique
and `undoneByJobId` closes the original); older jobs' before-values no longer describe the
catalog. Eligibility lives in one pure `undoEligibility` function shared by the job route's loader
and action. Three bugs shaped this:

- Undoing a metafield set on a product that had no metafield produced a null after-value, which
  `metafieldsSet` rejects, so the metafield was never removed. A null after-value now routes to
  `metafieldsDelete`; it is the only case where an after-value can be null.
- A canceled job's applied items were not undoable, although the cancel dialog promised they
  would be. `canceled` is now an undoable status.
- A job that applied nothing could become the "latest" job and block undo of the one that did.
  `latestUndoableJobId` now requires `successCount > 0`.

## 9. CSV import is validated strictly and imported as absolute values

`parseImportCsv` reports every problem as `row N, column X` with a reason, and valid rows in the
same file stay importable. Import values are absolute, staging diffs them against live data, and
unchanged rows are skipped, so re-applying a file is a no-op; a SHA-256 hash of the upload warns
when the same file was already imported. Uploads are capped at 5 MB in the multipart handler and
parsed in memory. Hardening found these edge cases:

- Prices with three or more decimals were accepted, so the stored after-value could differ from
  the value Shopify rounds to and later trip the stale check. Prices now allow at most two
  decimals, with a distinct message.
- A duplicated column silently used its first occurrence and dropped the later values. Duplicate
  known columns are now rejected.
- A file with only `product_id`/`variant_id` would stage an all-skipped no-op. It is rejected as
  having no editable columns.
- A UTF-8 BOM does not break the header, because every header and cell is trimmed and `trim()`
  strips U+FEFF; this is covered by a regression test along with CR-only line endings.

## 10. Escape formula triggers on export

`escapeCsvCell` prefixes a quote to any cell that a spreadsheet would treat as a formula. The
original guard covered `=`, `+`, `-`, and `@` but missed a leading tab or carriage return, which
spreadsheets also treat as formula triggers; both are now included. Import reverses the guard
with `unescapeCsvCell`, which drops a leading quote only when a trigger character follows it.
Before that, re-importing an export changed every product whose first tag started with a
trigger (a tag such as `-20%` came back as `'-20%`). All quoting goes through `csv-stringify`
and `csv-parse` rather than hand-split lines.

## 11. Money is rounded half away from zero

`roundHalfUp2` scales to cents and rounds half away from zero with a small epsilon so binary
floating point (for example `1.005`) does not round the wrong way, and every computed price is
normalized with `toFixed(2)`. A percentage or amount adjustment that would produce a negative
price flags the row as invalid in the preview, and invalid rows are excluded from apply.

## 12. Saved state is parsed defensively

`loadSavedFilters` used to `JSON.parse` each stored filter inside the product-browser loader.
One corrupt or legacy row threw, the loader's catch turned it into an upstream error, and the
whole page failed while every saved filter disappeared. `parseSavedFilter` now parses each row
defensively, keeps only known and valid fields, and returns null on unreadable JSON; the loader
skips and logs bad rows. Saved edit-sets are re-validated with the same `validateEditSet` used by
the builder, so there is one validation path.

## 13. Tenant isolation and data cleanup

Every job, item, saved filter, saved edit-set, and export download is queried by the
authenticated `session.shop`, and a job belonging to another shop returns `NOT_FOUND` rather than
a permission error so its existence does not leak. `app/uninstalled` deletes sessions and cancels
active jobs; `shop/redact` deletes the shop's jobs, items, saved filters, saved edit-sets, and
sessions. The worker expires `draft`/`staged` jobs older than 24 hours and deletes export files
after 7 days, clearing `resultPath` so the download link returns a friendly 404.

## 14. Dependency pins that are deliberate

Transitives that ship vulnerable versions their parents' ranges still allow are forced through
`overrides`, because the patched versions sit outside those ranges: five build-time packages under
`@remix-run/dev`, plus `body-parser` and `qs` under the Express server in `@remix-run/serve`. Vite stays
on 6 because `@remix-run/dev` 2.x declares `^5.1.0 || ^6.0.0`. `turbo-stream` is intentionally not
overridden: its patched 3.x line is incompatible with Remix 2 single fetch, which this app enables.
With the override applied, typecheck, lint, tests, and build all still passed while every loader
response decoded to no data, because the suite never crosses the single-fetch boundary. The fix
upstream is a move to React Router 7, which is a framework migration rather than a version bump.
