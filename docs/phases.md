# Phases: shopify-bulk-editor

Phase N+1 does not start until the owner approves phase N. Phases are ordered smallest-useful-shippable first; every phase leaves the app runnable and testable. One commit per feature/task, in the order listed.

The project's senior differentiators are hard requirements of Phases 1 and 2, not stretch goals: correct bulk machinery (bulk query export with `bulk_operations/finish` webhook + polling fallback; throttled cost-aware sequential mutations for applies), the safety model (explicit preview gate, stored before-values, per-item partial-failure reporting), and CSV import validation (row+column errors, dry-run preview, idempotent re-apply). Phase 2 is deliberately the largest phase because none of these may slip later.

---

## Phase 1: Foundation and product browser

Stand up auth, the embedded shell, webhooks, the full schema, structured logging, and a working product browser with saved filters.

### Goal
Install on a dev store and usefully browse, filter, and save filters over real products. All models exist so later phases only add behavior, not migrations for known entities.

### Definition of done
- `npm install`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` all pass.
- OAuth completes on a fresh dev store; a `Session` row exists; app renders embedded with Polaris and App Bridge nav (Products, Jobs, Import — Jobs/Import may be empty shells).
- `/webhooks` verifies HMAC; `app/uninstalled` clears sessions; compliance topics return 200; `bulk_operations/finish` is registered (handler logs and no-ops until Phase 2).
- Product browser filters by collection, vendor, tag, status, and title (AND-combined), paginates past 250 products, and shows an empty state for no matches.
- Saved filters: create (unique name per shop), apply, delete.
- Structured logger and shared error format in place; no `console.log`.
- Missing required env vars fail startup with a readable error.

### Manual test checklist
- [ ] Copy `.env.example` to `.env`, fill values, `npm run dev`, install on a dev store; OAuth completes and lands embedded.
- [ ] Confirm a `Session` row via `npx prisma studio`.
- [ ] Filter by vendor + status together; results match the same query in Shopify Admin search.
- [ ] Page forward and back through more than 250 products; no duplicates or gaps.
- [ ] Save a filter, reload, re-apply it with one click; delete it; a duplicate name shows a field error.
- [ ] Filter matching nothing shows an `EmptyState`, not a blank table.
- [ ] `shopify app webhook trigger` for `app/uninstalled` and a compliance topic; confirm cleanup / 200. Send a bad-HMAC request; confirm 401 and a log line.
- [ ] Remove a required env var; startup fails with a readable message.

### Commits
1. `build: scaffold remix vite app with typescript config`
2. `chore: add eslint (shopify config) and prettier`
3. `feat(db): add prisma schema (session, savedfilter, job, jobitem) and client singleton`
4. `feat(auth): configure shopify app remix with prisma session storage and oauth routes`
5. `feat(logging): add structured logger and shared error format`
6. `feat(app): add embedded shell with polaris, app bridge nav, and error boundary`
7. `feat(webhooks): add endpoint with hmac verification, uninstall cleanup, compliance topics`
8. `feat(products): add product browser with filters and pagination`
9. `feat(products): add saved filters`
10. `chore: fail fast on missing required env vars`

---

## Phase 2: Bulk engine — jobs, edit sets, preview, apply, CSV round-trip

The core of the product and all senior differentiators: the job worker, staged previews with before-values, cost-aware applies with per-item results, bulk-query export with webhook + polling completion, and validated CSV import with dry-run preview and idempotent re-apply.

### Goal
A merchant can stage an edit over filtered products, see every before/after value, apply it as a watched background job with per-item outcomes, export the filtered set to CSV, and re-import an edited CSV through the same preview gate.

### Definition of done (hard requirements)
- **Preview gate:** no code path writes product data except the worker processing a job that reached `queued` from `staged` via the explicit apply intent. Verified by code inspection and by the double-submit test below.
- **Before-values:** every applied `JobItem` stores the prior values of exactly the fields it changed, visible in the job detail.
- **Per-item reporting:** finished jobs satisfy `succeeded + failed + skipped = total`; each failure shows product title and reason; a partially failed job reads `completed_with_errors`, never plain success.
- **Stale safety:** an item whose live value differs from its staged before-value is `skipped_stale` with a reason (price/status/metafield ops; tag ops merge by design).
- **Throttling:** the worker paces from `extensions.cost`; a 500-item apply produces no throttle errors in logs.
- **Resume:** killing the server mid-apply and restarting resumes the job; already-applied items are not re-processed.
- **Export:** uses `bulkOperationRunQuery`; completion via `bulk_operations/finish` webhook, with the 15-second node poll as fallback; JSONL converted to CSV with the formula-injection guard; download from the job screen.
- **Import:** row+column validation messages (`row 7, column price: ...`); valid rows stage as a normal preview (dry run); invalid rows shown alongside, never applied; duplicate file hash warns; re-applying an already-applied file changes nothing (all items `skipped_unchanged`).
- Progress screens poll every 2 seconds while active and stop on terminal status.
- All Phase 2 pure logic (price math, edit-set validation, filter compiler, CSV validation, diffing, throttle pacing) is unit tested.

### Manual test checklist
- [ ] Select ~50 products by filter, stage "price +10%": preview shows 50 rows with correct 2-decimal after-prices; Shopify Admin shows no change while previewing.
- [ ] Discard the preview; nothing changed. Stage again and apply; watch progress advance; confirm final prices in Admin.
- [ ] Stage "adjust amount -5" where a resulting price would go negative; the row is flagged `invalid` and excluded from apply.
- [ ] Double-click Apply; exactly one job runs, second click gets a friendly conflict message.
- [ ] Delete a targeted product between staging and apply; its item fails/skips with a reason; the rest complete; job ends `completed_with_errors`.
- [ ] Change one product's price manually between staging and apply; that item is `skipped_stale`; others apply.
- [ ] Kill the dev server mid-apply; restart; job resumes and finishes; counts add up; no product double-adjusted.
- [ ] Export the current filter; download appears without manual refresh; row count matches variant count; a title starting with `=` is escaped in the file.
- [ ] Block the webhook (pause the tunnel) and export again; polling fallback completes the job.
- [ ] Edit the exported CSV (change some prices, one malformed price, one bad status, one unknown variant id); import: precise row+column errors for the bad rows, correct before/after preview for good rows; apply and verify in Admin.
- [ ] Re-import the same file: duplicate warning shown; applying yields zero applied items (all unchanged-skips).
- [ ] Upload a non-CSV and an over-limit file; both rejected with friendly messages.

### Commits
1. `feat(jobs): add worker loop with claiming, heartbeat, and crash recovery`
2. `feat(jobs): add cost-aware throttle from graphql cost extensions`
3. `feat(edits): add draft job creation from browser selection`
4. `feat(edits): add edit set builder with server-side validation`
5. `feat(edits): stage jobs with before-value snapshots and absolute after-values`
6. `feat(edits): add before/after preview screen with apply and discard`
7. `feat(edits): apply staged jobs with per-item results and stale-value skip`
8. `feat(jobs): add job progress screen with polling and per-item failure report`
9. `feat(export): start bulk query export jobs`
10. `feat(export): complete exports via bulk_operations/finish webhook with polling fallback`
11. `feat(export): convert jsonl to csv with injection guard and download route`
12. `feat(import): parse and validate csv with row and column errors`
13. `feat(import): stage import jobs with dry-run preview and duplicate-file warning`

---

## Phase 3: Job history and undo

### Goal
Merchants can review every past job and safely reverse the most recent applied one.

### Definition of done
- Job history lists all of the shop's jobs, newest first, with type, status, counts, timestamps; detail view filters items by outcome; shop isolation verified.
- Undo offered only on the shop's most recent applied edit/import job with no completed undo; the button explains why when unavailable.
- Undo builds inverse items from stored before-values (tag ops invert the delta; price/status/metafield restore the before value), goes through the standard staged preview, and applies as a normal job.
- Items changed since the original apply are skipped as conflicts and reported.
- Completing an undo sets `undoneByJobId` on the original; a second undo of the same job is impossible.

### Manual test checklist
- [ ] Run two jobs; history shows both with correct counts; a second dev store sees neither.
- [ ] Undo the latest job: preview shows inverse changes; apply; spot-check restored values in Admin.
- [ ] Manually change one affected product before undoing; that item is skipped with a conflict reason.
- [ ] Try to undo the older job and the already-undone job; both refused with clear reasons.
- [ ] Undo an import job; prices return to pre-import values.

### Commits
1. `feat(jobs): add job history list with outcome filters`
2. `feat(undo): compute inverse edits and create staged undo jobs`
3. `feat(undo): enforce undo eligibility and conflict skips`

---

## Phase 4: Operational hardening

### Goal
Close the operational gaps before launch: cancellation, cleanup, and a full unhappy-path audit.

### Definition of done
- Queued and running jobs can be canceled; a running job stops at the next item boundary; applied items remain recorded and the job reads `canceled` with accurate counts.
- Stale `draft`/`staged` jobs older than 24 hours and export files older than 7 days are cleaned up by the worker; downloads past retention return a friendly not-found.
- Full sweep of the Phase verification list below passes; findings fixed.
- Launch checklist items that can be done pre-deploy are done.

### Manual test checklist
- [ ] Cancel a running 500-item job mid-flight; it stops promptly; counts are consistent; history shows `canceled`.
- [ ] Cancel a queued job before the worker picks it up; it never runs.
- [ ] Age a staged job and an export file past their windows (adjust timestamps in dev DB); cleanup removes them; the stale download link shows a friendly message.
- [ ] Re-run the complete Phase verification list.

### Commits
1. `feat(jobs): cancel queued and running jobs`
2. `chore(jobs): expire stale staged jobs and clean old export files`
3. `docs: update readme for implemented feature set`

---

## Phase 5: Saved edit-sets

### Goal
A merchant can save a named edit-set (the field + operation + value configuration built in the edit-set
builder) and reuse it later against a new product selection, without rebuilding it each time. Save,
list, load into the builder, rename, and delete. Loading a saved set populates the builder only; it
still goes through the mandatory staged preview before anything is applied.

### Definition of done (hard requirements)
- **Preview gate untouched:** loading a saved set only fills the builder's operations (a `draft` job);
  it never stages, queues, or applies. The one path to a write is still `draft -> staging (preview) ->
  queued (explicit apply) -> worker`. No saved-edit-set code creates or mutates a `Job`.
- **Shop scoping:** every read and write is scoped to the session shop; one shop can neither list, load,
  rename, nor delete another shop's edit-sets. `(shop, name)` is unique per shop.
- **Same validation:** a saved config is stored only if it passes the existing `validateEditSet`, and a
  loaded config passes the identical `validateEditSet` before it can be staged. No second validation
  path.
- **Round-trip fidelity:** saving then loading a set yields the same normalized operations.
- Save (from the builder), list, load-into-builder, rename, and delete all work; friendly errors for a
  duplicate name, an empty/too-long name, and an unreadable stored row (skipped, logged, page survives).
- Shop redact deletes the shop's saved edit-sets alongside its other data.
- `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all pass; existing tests stay
  green; new tests cover the four properties above.

### Manual test checklist
- [ ] In the builder, configure a couple of operations, Save as edit-set with a name; it appears in the
  saved-set list.
- [ ] Start a new bulk edit over a different selection; load the saved set; the builder fills with the
  saved operations; Preview then Apply as normal.
- [ ] Loading a set never applies on its own; the Apply button only appears after the preview stage.
- [ ] Rename a set; the new name shows and a duplicate name is refused with a field error.
- [ ] Delete a set; it disappears; deleting is idempotent.
- [ ] Save with an empty name and a 51-character name; both refused. Save an invalid config (e.g. a
  price with no value); refused with the same messages the builder shows.
- [ ] A second dev store sees none of the first store's saved sets.

### Commits
1. `docs: add saved edit-sets phase to phases.md`
2. `feat(db): add saved edit-set model and migration`
3. `feat(edits): add shop-scoped saved edit-set store with tests`
4. `feat(edits): save the current builder config as a named edit-set`
5. `feat(edits): load a saved edit-set into the builder`
6. `feat(edit-sets): add saved edit-set management page`
7. `feat(webhooks): delete saved edit-sets on shop redact`
8. `docs: document saved edit-sets in readme and memory`

---

## Phase verification

Run after every phase before marking it done.

- [ ] `npm run dev` starts with no errors; `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` all pass.
- [ ] Browser console and server logs free of new warnings/errors.
- [ ] Unhappy paths:
  - [ ] Invalid input (bad percent, bad status, malformed CSV cell, over-cap selection) rejected with friendly messages.
  - [ ] Empty forms (no operations, empty filter save name, no file chosen) show field errors, save nothing.
  - [ ] Upstream failure (kill tunnel / simulate GraphQL error) surfaces a banner or failed items, never a crash or stack trace.
  - [ ] Duplicate submit on every action (save filter, stage, apply, import, undo) does not double-write; buttons disable in flight.
  - [ ] Refresh mid-action (mid-staging, mid-apply, mid-import) leaves data consistent; polling screens recover on reload.
- [ ] Empty states: no products matched, no saved filters, no jobs yet, job with zero changed items.
- [ ] Long inputs (255-char tag, long titles/vendors, 5,000-row CSV) render without breaking layout; tables truncate or wrap via Polaris.

## Backlog

_(empty — record out-of-scope requests here with a one-line description and date)_
