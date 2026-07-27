# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No versioned release has been tagged yet; everything below is unreleased and developed on `main`.

## [Unreleased]

### Added

- Product browser with collection, vendor, tag, status, and title filters (AND-combined),
  cursor pagination past 250 products, and per-shop saved filters.
- Edit set builder - price set / adjust-percent / adjust-amount, status, tag add/remove, and
  metafield set - validated on the server.
- Staged before/after preview as a hard write gate: no code path writes product data except the
  worker processing a job that reached `queued` from `staged` via the explicit apply intent.
- Tracked apply jobs run by a DB-backed in-process worker: cost-aware throttling from GraphQL
  `extensions.cost`, per-item outcomes (applied / failed / skipped-stale / skipped-unchanged),
  captured before-values, live progress polling, and crash-safe resume.
- CSV export via `bulkOperationRunQuery`, completed by the `bulk_operations/finish` webhook with
  a 15-second polling fallback, converted to CSV with a spreadsheet formula-injection guard, and
  served through an authenticated shop-scoped download route.
- CSV import with precise `row N, column X` validation, a dry-run preview through the same gate,
  a duplicate-file (SHA-256 hash) warning, and idempotent re-apply (unchanged rows skipped).
- Job history (shop-scoped, newest first) with per-item outcome filtering, and undo of the most
  recent applied edit or import job computed from stored before-values.
- Operational hardening: cancel queued and running jobs, expire stale draft/staged jobs after 24
  hours, and delete export files after 7 days.
- Repository tooling: MIT license, CI workflow (typecheck, lint, test, build), Dependabot,
  security policy, contributing guide, code of conduct, issue and pull-request templates, and a
  CSV parse throughput benchmark.

### Security

- Cleared 24 of 25 Dependabot alerts (`vite` 5 → 6, `vitest` 2 → 3, transitive `tar`, `esbuild`,
  and `estree-util-value-to-estree` pins via `overrides`). The one remaining alert
  (`turbo-stream`, DoS-only, authenticated routes only) is documented in `docs/memory.md`; its
  patched line is incompatible with Remix 2 single fetch.
