# Project Memory: shopify-bulk-editor

Running log of what is done, what is in flight, and decisions worth remembering. Update after every meaningful chunk of work; log every non-obvious decision with its reason. Keep entries short and dated, newest first within each section.

## Completed

- 2026-07-22 — Dependency security pass. Cleared 24 of 25 open Dependabot alerts (2 critical, 8 high,
  13 medium, 2 low → 1 high remaining); `npm audit` 16 → 8, all 8 being the one unfixable root cause
  below. Direct: `vite` 5.4.11 → 6.4.3, `vitest` 2.1.8 → 3.2.7. Transitive, via a new `overrides`
  block: `tar` 6.2.1 → 7.5.21, `esbuild` 0.17.6/0.21.5 → 0.25.12,
  `estree-util-value-to-estree` 1.3.0 → 3.5.0, plus `vite` pinned tree-wide to collapse a nested
  5.4.21 copy. No source changes were needed; 73 tests, typecheck, lint, and build stayed green at
  every step.

- 2026-07-22 — Senior quality pass. Four real defects found and fixed, each with a regression test
  that fails before the fix (73 tests green):
  1. `apply.server.ts` — undo of a metafield set on a product that had **no** prior metafield
     produced an after-value of `null` and called `metafieldsSet` with it. `MetafieldsSetInput.value`
     is non-null, so the undo item failed and the metafield was never removed. Now routes a null
     after-value to a new `metafieldsDelete` mutation. This is the only case where an after-value can
     be null (edit-set validation forbids a null set), so the branch is bounded to undo-of-backfill.
  2. `apply.server.ts` — the per-item progress increment was an unguarded `db.job.update`, so a
     cancel landing while the item's mutation was in flight could have its authoritative counts
     incremented on top; when the cancel hit the _final_ item the in-loop stop check never ran and
     `finalize()` no-ops on a non-running job, leaving the drift permanent (processedCount could
     exceed totalItems). Increment is now guarded on `status: "running"`, and the loop tail
     reconciles a canceled job's counts from its items.
  3. `throttle.server.ts` — `docs/architecture.md` specifies retrying an item once after a
     `THROTTLED` error, but `runGraphql` threw on any `errors` array, so a transient throttle
     permanently failed the item. Now retries once (the recorded cost block paces the retry through
     `beforeCall`) and fails only on a second THROTTLED.
  4. `csv.server.ts` — the formula-injection guard covered `= + - @` but not leading TAB (0x09) or
     CR (0x0D), which are also spreadsheet formula triggers.
     Reviewed and found sound, no change made: leaky-bucket pacing (cannot stall or busy-loop —
     `restoreRate <= 0` short-circuits, waits are finite, and pacing is sequential per call); stale-skip
     comparison (numeric price compare tolerates `10.0` vs `10.00`); percentage undo round-trip (exact,
     because undo restores the stored absolute before-string rather than re-applying an inverse
     percentage); tag add/remove inversion (apply diffs the two snapshot lists, which equals the delta,
     so unrelated tags added meanwhile survive); idempotent re-import (absolute values + unchanged-skip +
     file hash); export download authorization (shop-scoped `findFirst`, `resultPath` comes from the DB
     and never from user input, so no cross-shop read and no traversal). Investigated and dismissed: a
     UTF-8 BOM does **not** break import — `parseImportCsv` trims every header/cell and JS `.trim()`
     strips U+FEFF.
     Also added: CI + license badges and a "Design decisions" section in the README (sourced from
     `docs/architecture.md`/PRD, no invented rationale), a measured CSV parse throughput benchmark
     (`npm run bench`, separate vitest config so it stays out of CI), `SECURITY.md`, and a grouped
     monthly `.github/dependabot.yml`.
- 2026-07-22 — Repo housekeeping: added root `LICENSE` (MIT, 2026 Ali Raza) and
  `.github/workflows/ci.yml`. CI runs on push and pull_request to `main`: Node 24 via
  `actions/setup-node@v4` with npm cache, `npm ci`, `npm run prisma:generate`, then the four gate
  commands from `docs/testing.md` (`typecheck`, `lint`, `test`, `build`). Dummy Shopify/database env
  vars are set at the job level because `app/lib/env.server.ts` fails fast on missing variables when
  `app/shopify.server.ts` is imported; no real credentials are needed since the Admin GraphQL client is
  mocked and each integration test pushes its own throwaway SQLite file. Deploy, Prisma migrations, and
  the manual dev-store QA checklists stay out of CI (they need a real store and hosting).
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

- 2026-07-22 — **`turbo-stream` left at 2.4.1 (GHSA-rxv8-25v2-qmq8, high, CVE-2026-34077).** The only
  alert not fixed. Patched line is 3.x, but it is API-incompatible with Remix 2 single fetch, which
  this app enables (`v3_singleFetch: true`): v3 `decode()` resolves to the payload directly while
  Remix reads `decoded.value`, and v3 encodes/decodes string streams where Remix pipes bytes.
  Verified empirically — with the override applied, typecheck, lint, all 73 tests, and the build
  still pass while `decoded.value` is `undefined`, i.e. every loader response would silently carry
  no data. The gate cannot catch this because the suite covers pure lib/worker logic and never
  crosses the single-fetch boundary. Upstream fix is React Router 7.14+, a framework migration that
  would rewrite a documented stack decision, so it was left alone per the stop rule. Exposure is
  low: DoS-only (CVSS 3.1 7.5, `C:N/I:N/A:H`), and every route sits behind Shopify session-token
  auth, so it is not anonymously reachable. Revisit if/when the app moves to React Router 7.
- 2026-07-22 — Vite 6 is the ceiling, not Vite 7: `@remix-run/dev` 2.17.5 (latest 2.x) declares
  `vite: "^5.1.0 || ^6.0.0"`. Recorded in `docs/architecture.md`.
- 2026-07-22 — Transitive pins use `overrides` rather than dependency bumps because the patched
  versions sit outside `@remix-run/dev`'s own manifest ranges. `cacache` declares `tar` but never
  imports it, and there are no `.mdx` or `.css.ts` files, so the estree/vanilla-extract paths are
  dead code here — the pins are inert at runtime. Documented in `docs/architecture.md` with a note to
  drop entries on a Remix upgrade rather than carry stale pins.
- 2026-07-22 — The `README.md` benchmark provenance line still reads "vitest 2.1.8" on purpose: it
  records the toolchain those published medians were measured under. A spot re-run on vitest 3.2.7
  came in at or faster than every documented range, but re-measuring under the full 7-repeat protocol
  is out of scope for a security pass, so the numbers and their provenance were left intact.
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
- 2026-07-23 — README visuals: added four screenshots under `docs/images/` (product browser, preview
  gate, job outcomes/undo, CSV import). No live store or Shopify credentials exist here, so App Bridge
  + OAuth cannot run. Captured honestly by mounting the real Remix route default components in a
  throwaway Vite harness with a react-router `createMemoryRouter` stub loader (the app's own
  `@remix-run/react` hooks delegate to react-router 6.30, so no `@remix-run/testing` was needed),
  wrapped in Polaris, fed mocked Admin-API-shaped data, and screenshotted with Playwright (chromium,
  1280x900, 2x). Server-only imports (`~/db.server`, `~/shopify.server`, `~/lib/logger.server`,
  `~/lib/csv.server`, `@remix-run/node`, `node:crypto`) were aliased to stubs because the routes touch
  them only in loaders/actions, never in the render path — no app code, auth, or deps were changed.
  The harness lived outside git and was deleted after capture. Every README caption states plainly the
  shots were rendered locally against a mocked Admin API, not a live store.
