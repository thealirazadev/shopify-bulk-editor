# Project Memory: shopify-bulk-editor

Running log of what is done, what is in flight, and decisions worth remembering. Update after every meaningful chunk of work; log every non-obvious decision with its reason. Keep entries short and dated, newest first within each section.

## Completed

- 2026-07-18 — Phase 4 (operational hardening) complete and green. Cancel queued/running jobs (guarded
  transition to `canceled` with recomputed counts; the running worker stops at the next item boundary
  and applied items stay applied/undoable) with a confirm modal. Worker cleanup cycle (every 10 min):
  expire draft/staged jobs older than 24h to `discarded`, delete export files older than 7 days and
  clear `resultPath` (download then returns a friendly 404). README updated to the implemented feature
  set. Audited: product-write mutations exist only in `apply.server`; the only `queued` transition for
  editable jobs is the guarded apply intent from `staged`. Booted the production build — Shopify config
  loads, worker starts, `/` redirects to auth. 68 tests pass; typecheck/lint/build clean.
- 2026-07-18 — Phase 3 (job history and undo) complete and green. Job history list (IndexTable, newest
  first, shop-scoped, paginated, status badges, row navigation). Undo: pure inverse computation swaps
  each applied item's before/after; undo job created directly in `staged` with pre-computed items and
  runs through the standard preview + apply path; eligibility enforced (most-recent applied edit/import
  only, not already undone, `undoOfJobId` unique blocks concurrent undo); apply completion sets the
  original's `undoneByJobId`; items changed since apply are `skipped_stale`. Tests: inverse computation
  unit tests + undo apply integration (restore + undoneByJobId + stale conflict skip). 67 tests pass.
- 2026-07-18 — Phase 2 (bulk engine) complete and green. Pure logic: edit-set validation + price math
  (half-up rounding, negative-flag, tag deltas, unchanged detection), throttle pacing, CSV export
  serialization + injection guard, CSV import row/column validation. Worker: DB-backed loop with
  claiming/heartbeat/crash-recovery, cost-aware throttled apply with per-item stale-skip + partial
  failure + live counts, staging (edit + import) with before-value snapshots, bulk-query export with
  webhook + 15s polling completion (guarded transition), JSONL->CSV + authenticated download route.
  UI: edit-set builder, before/after preview with apply/discard + confirm modal, job progress/detail
  with polling + per-item results, CSV import upload with dry-run preview + duplicate-file warning.
  Integration tests (mocked admin + throwaway SQLite): apply outcomes/resume, staging edit+import,
  export completion/idempotency/failure. Verification: typecheck, lint, 61 tests, build all pass.
- 2026-07-18 — Phase 1 (foundation and product browser) complete and green: scaffold, eslint/prettier,
  Prisma schema (Session, SavedFilter, Job, JobItem) + init migration, Shopify auth + OAuth routes,
  structured logger + shared error format, embedded shell with App Bridge nav + error boundary, webhook
  endpoint (uninstall/scope/bulk-finish/compliance/shop-redact), product browser (IndexFilters +
  IndexTable, cursor pagination, filter compiler), saved filters (create/apply/delete), env fail-fast.
  Verification: `npm run typecheck`, `npm run lint`, `npm run test` (16 pass), `npm run build` all pass.
- 2026-07-18 — Planning documentation created (README, PRD, architecture, rules, phases, design, testing, api-contracts, launch checklist, `.env.example`).

## In progress

- Phase 2 (bulk engine) starting.

## Decisions log

- 2026-07-18 — Applies use throttled sequential mutations, not `bulkOperationRunMutation`: per-item results, stale checks, and undo capture need item-at-a-time handling, and target scale (≤5,000 items) fits sequential throughput. Export still uses a bulk query. Rationale in `docs/architecture.md`.
- 2026-07-18 — Background work is a DB-backed `Job`/`JobItem` table with an in-process worker loop; no queue library. Requires a single app instance in production.
- 2026-07-18 — CSV v1 covers price, status, and tags only; metafields are UI-edit only.
- 2026-07-18 — Followed the reference `shopify-remix-starter` for auth/session/webhook/Polaris/Prisma
  patterns and pinned versions; added only `csv-parse` 5.6.0 and `csv-stringify` 6.8.1 as documented.
- 2026-07-18 — Committed logging (logger + errors) before the auth commit because `shopify.server.ts`
  and `entry.server.tsx` depend on the logger; keeps every commit building. Commit messages otherwise
  follow `docs/phases.md`.
- 2026-07-18 — Owner directive mid-run: make small, granular commits (one discrete change each). Applied
  from the first commit; each commit stays working, conventional, no attribution/emoji.
- 2026-07-18 — Product browser filters drive URL search params (debounced) so filtering runs server-side
  through the loader; saved filters render as IndexFilters tabs. Live-store verification of the exact
  GraphQL pagination/search is a documented manual step (no dev store available in this environment).
