# Project Memory: shopify-bulk-editor

Running log of what is done, what is in flight, and decisions worth remembering. Update after every meaningful chunk of work; log every non-obvious decision with its reason. Keep entries short and dated, newest first within each section.

## Completed

- 2026-07-18 — Planning documentation created (README, PRD, architecture, rules, phases, design, testing, api-contracts, launch checklist, `.env.example`). Awaiting owner review before implementation.

## In progress

_(nothing — implementation has not started)_

## Decisions log

- 2026-07-18 — Applies use throttled sequential mutations, not `bulkOperationRunMutation`: per-item results, stale checks, and undo capture need item-at-a-time handling, and target scale (≤5,000 items) fits sequential throughput. Export still uses a bulk query. Rationale in `docs/architecture.md`.
- 2026-07-18 — Background work is a DB-backed `Job`/`JobItem` table with an in-process worker loop; no queue library. Requires a single app instance in production.
- 2026-07-18 — CSV v1 covers price, status, and tags only; metafields are UI-edit only.
