# shopify-bulk-editor

An embedded Shopify admin app for safe bulk editing of products, variants, and metafields. A merchant filters products, stages an edit set (set or adjust price, change status, add or remove tags, set a metafield), previews every before/after value, applies the change as a tracked background job, and can undo the last applied job. It also round-trips CSV: export filtered products, re-import an edited file with row-level validation and a dry-run preview before anything is written.

Status: planning — docs under review

## Planned stack

- Remix (Vite) + TypeScript
- `@shopify/shopify-app-remix` for OAuth, sessions, webhooks
- `@shopify/polaris` and `@shopify/app-bridge-react` for the embedded UI
- Prisma ORM with SQLite (dev) and Postgres/MySQL (prod)
- DB-backed job table with an in-process worker for background applies
- Shopify Admin GraphQL API: bulk query for export, throttled sequential mutations for applies
- `csv-parse` / `csv-stringify` for the CSV round-trip

See `docs/` for the PRD, architecture, API contracts, phases, and engineering rules.

## Install

TBD until implementation starts.

## Run

TBD until implementation starts.

## Test

TBD until implementation starts.
