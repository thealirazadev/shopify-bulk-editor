# Launch Checklist: shopify-bulk-editor

Work through before shipping to production. Nothing here should be assumed done.

## Environment and configuration
- [ ] Production env vars set (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`, `DATABASE_URL`).
- [ ] `SHOPIFY_APP_URL` points to the real production domain, not a tunnel.
- [ ] Production `DATABASE_URL` uses Postgres, not SQLite.
- [ ] Secrets in the host's secret manager, not committed anywhere.
- [ ] Debug/verbose logging off in production; log level appropriate.
- [ ] Deployment runs exactly one app instance (in-process worker constraint) and this is documented in the deploy config.
- [ ] `storage/exports/` is on a persistent disk that survives deploys.

## Reliability and errors
- [ ] Error tracking connected and receiving server errors.
- [ ] Loading states on every fetch and submit (skeletons, button spinners, progress bars).
- [ ] Friendly 404 page and error-boundary page; no stack traces to users.
- [ ] Structured logs verified in production (include `shop`, `requestId`, `jobId`).
- [ ] Worker recovery verified in production: restart the dyno mid-job; job resumes, nothing double-applied.
- [ ] Stale-job and export-file cleanup verified running.

## UI and accessibility
- [ ] Embedded rendering verified in Shopify Admin (framing, App Bridge nav, URL updates).
- [ ] Mobile/narrow viewport checked, including the preview and progress tables.
- [ ] Empty states verified (no products, no saved filters, no jobs, zero-change preview).
- [ ] Keyboard navigation and focus order verified on browser, builder, preview, and job screens.

## Shopify-specific
- [ ] All webhooks registered and reachable in production: `app/uninstalled`, `app/scopes_update`, `bulk_operations/finish`, compliance topics.
- [ ] Webhook HMAC verification confirmed against production requests.
- [ ] `bulk_operations/finish` handling and the polling fallback both verified in production (one export with webhooks healthy, one with delivery blocked).
- [ ] Scopes in `shopify.app.toml` and `SCOPES` match actual usage (`read_products,write_products`); nothing unused requested.
- [ ] `app/uninstalled` cleanup verified (sessions removed, running jobs canceled).
- [ ] A full-scale rehearsal on a staging store: 1,000+ item apply, export, import, undo — counts and values verified.

## Data and safety
- [ ] Production database migrated with `prisma migrate deploy`; backups configured.
- [ ] Undo verified against production data at least once before announcing.
- [ ] Job retention/cleanup windows confirmed acceptable to the owner (staged 24h, export files 7 days).
- [ ] CSV formula-injection escaping spot-checked on a real export opened in a spreadsheet.
