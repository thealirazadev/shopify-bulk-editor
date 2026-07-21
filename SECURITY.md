# Security Policy

## Supported versions

This project is developed on `main`. Security fixes land on `main`; there are no
long-lived release branches.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do not open a public issue.

- Use [GitHub private vulnerability reporting](https://github.com/thealirazadev/shopify-bulk-editor/security/advisories/new)
  for this repository.

Please include the affected version or commit, reproduction steps, and the impact
you observed. You can expect an initial response within 7 days and a fix or a
documented mitigation for confirmed issues within 30 days.

## Scope

This app runs as an embedded Shopify Admin app with `read_products,write_products`
scope and writes to a merchant's catalog. Reports that are especially in scope:

- Authentication or session-handling flaws in the embedded app or OAuth routes.
- Cross-shop data access — any path where one shop can read or modify another
  shop's jobs, saved filters, or export files. All job, item, and export-download
  queries are scoped by `shop`; a bypass is a valid report.
- Webhook HMAC verification bypass.
- Unauthenticated access to generated export CSVs under `storage/exports/`.
  These are served only through the authenticated, shop-scoped download route.
- Injection of any kind, including spreadsheet formula injection through exported
  CSV cells, and SQL injection (queries go through Prisma's parameterized client).

## Out of scope

- Vulnerabilities in Shopify's own APIs or Admin UI — report those to Shopify.
- Findings that require a merchant to install a malicious app or to already hold
  valid admin credentials for the store.
- Missing hardening headers on non-embedded routes with no demonstrated impact.

## Operational notes for deployers

- Never commit real credentials. `SHOPIFY_API_SECRET` and `DATABASE_URL` belong in
  the environment; `.env.example` carries dummy values only.
- Run exactly one app instance: the background worker is in-process and claims
  jobs without cross-instance locking.
- `storage/exports/` must not be served directly by a web server. Export files are
  deleted after 7 days.
