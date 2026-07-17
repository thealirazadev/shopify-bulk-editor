# Engineering Rules: shopify-bulk-editor

Binding for anyone working in this repository. When a rule and a request conflict, follow the rule and flag the conflict.

## Conventions

### Preferred libraries and patterns
- Use `@shopify/shopify-app-remix` for all auth, session, and webhook work. Never hand-write OAuth, HMAC checks, or session token validation.
- `authenticate.admin(request)` at the top of every embedded loader and action; scope every database query by the authenticated `session.shop`.
- Admin GraphQL only (`admin.graphql(...)`). No REST Admin API. The worker uses the same GraphQL client via an offline session.
- Prisma through the shared client in `app/db.server.ts`; never instantiate `PrismaClient` ad hoc.
- Polaris for all UI; App Bridge for navigation, toasts, and pickers. No other UI or CSS framework.
- CSV parsing/serialization goes through `csv-parse`/`csv-stringify` in `app/lib/csv.server.ts`. Never split CSV lines by hand.
- Safety invariants (these are product rules, not preferences):
  - Product writes happen only in `app/worker/apply.server.ts`, driven by a `queued` job. No loader or action mutates product data directly.
  - No job reaches `queued` except from `staged` via the explicit `apply` intent.
  - Every applied `JobItem` has its `beforeJson` populated before the mutation runs. A write without a captured before-value is a bug.
  - Job status transitions are guarded updates (`updateMany` with the expected current status in the `where`); never blind `update` on status.
  - All relative adjustments resolve to absolute after-values at staging time; the apply path writes absolute values only.

### What to avoid
- No REST calls, no direct `fetch` to Shopify endpoints a package helper covers.
- No global client-side state library; loaders/actions plus polling revalidation hold state.
- No hand-rolled theme or inline styles bypassing Polaris tokens.
- No `any` to silence the compiler; model the real shape.
- No queue/worker library; the DB-backed worker in `app/worker/` is the only background mechanism.

### Naming
- **Route files** — Remix flat routes. Embedded routes under `app.*` (`app._index.tsx`, `app.edits.$id.tsx`, `app.jobs.$id.download.tsx`); auth routes `auth.$.tsx`, `auth.login`; webhook route `webhooks.tsx`.
- **Server-only modules** — Suffix `.server.ts` so they never reach the client bundle. Worker modules live in `app/worker/`, pure logic in `app/lib/`.
- **Files** — kebab-case for non-route modules (`edit-set.ts`); route files follow Remix conventions.
- **Functions and variables** — `camelCase`; booleans read as predicates (`canUndo`, `isStale`).
- **React components** — `PascalCase`, one primary component per file.
- **Prisma models** — `PascalCase` singular (`Job`, `JobItem`, `SavedFilter`); fields `camelCase`. Status/type string values are lower_snake (`skipped_stale`, `csv_import`) and defined once as TypeScript union types in `app/lib/`.
- **Types/interfaces** — `PascalCase`, no `I` prefix.

### Commit format
- Conventional Commits: `type(scope): subject`, short and imperative. Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`. Scopes here: `auth`, `db`, `app`, `products`, `edits`, `jobs`, `export`, `import`, `undo`, `webhooks`, `logging`.
- ONE COMMIT PER FEATURE OR TASK. Never batch features. `docs/phases.md` lists the expected commits per phase in order.

### Dependencies and migrations
- Pin exact versions (no `^`/`~`) in `package.json`; commit `package-lock.json` in the same commit as any dependency change.
- No new, upgraded, or removed dependency without approval. The approved runtime set is listed in `docs/architecture.md`.
- Schema changes only through `npx prisma migrate dev --name <change>`. Never edit the database by hand; never edit a migration that has been applied or committed — correct mistakes with a new migration.

## Error handling and logging

- Every external call — Admin GraphQL, JSONL result download, database, file I/O on `storage/`, CSV parsing — handles failure explicitly. No unguarded awaits on network, DB, or disk.
- Inside the worker, an item-level failure marks that `JobItem` `failed` with a friendly message and continues the job; only infrastructure failures (DB down, auth revoked) fail the job itself, with `errorCode`/`errorMessage` set. A job must never end with items still `pending` and no terminal explanation.
- Every GraphQL mutation response's `userErrors` is inspected; non-empty means the item failed, first message surfaced, full array logged.
- Users see short, friendly messages in Polaris `Banner`/toast or item rows. Detailed context (requestId, shop, jobId, GraphQL errors, stacks) goes only to logs. Never render a stack trace or raw error object.
- One error format everywhere for JSON errors: `{ error: { code, message, requestId } }` per `docs/api-contracts.md`, built by helpers in `app/lib/errors.ts`.
- Structured logging from day one via `app/lib/logger.server.ts`: JSON lines with at least `level`, `msg`, `shop`, `requestId`, plus `jobId` in worker logs. No `console.log` in committed code.
- Expected errors return typed data from loaders/actions; unexpected errors bubble to the Remix `ErrorBoundary`, which renders a friendly Polaris page.

## Security

- No hardcoded secrets. Everything sensitive comes from `.env` (never committed); `.env.example` documents every variable with a dummy value and stays current.
- Webhooks: HMAC verified via `authenticate.webhook(request)`; invalid signature → 401 + log. Embedded requests: session token via `authenticate.admin(request)`; never trust `shop`/`host` query params directly.
- Validate all input server-side before use: filter fields, edit-set operations (per the table in `docs/api-contracts.md`), CSV uploads (size, type, row cap, per-cell rules), intents, and IDs. Client validation is a convenience only.
- Tenant isolation: every `Job`, `JobItem`, `SavedFilter`, and export-file read/write is filtered by the authenticated shop. Cross-shop IDs return `NOT_FOUND`, not `FORBIDDEN` (no existence leak).
- CSV formula injection: escape cells starting with `=`, `+`, `-`, `@` on export. CSV uploads are parsed as data only.
- Uploads: 5 MB cap enforced at the multipart parser, `.csv` only, parsed in memory, raw file not retained (only hash, name, and derived items).
- Export downloads are served through the authenticated resource route only; `storage/` is never web-exposed directly. Prisma parameterizes all queries; no raw SQL.
- **Protected routes:** all `app.*` routes require a valid Admin session token; `webhooks.tsx` requires valid HMAC and has no session; `auth.*` routes are public and rely on the package's state/nonce checks. There are no other routes.

## Simplicity (YAGNI / KISS)

- Build only what the current phase requires. No speculative features, config flags, or parameters.
- Prefer the boring, direct solution. The worker is a poll loop, not a framework; the throttle is arithmetic on `extensions.cost`, not a rate-limiting library.
- No abstraction until three real, existing use cases demand it. The module layout in `docs/architecture.md` is the approved set; new wrapper classes, managers, or utils files need owner approval first.
- Use library and platform features over reimplementation (Shopify package auth, Prisma migrations, `csv-parse`, Polaris components).
- Self-review before submitting: if it can be done in fewer lines without hurting readability, rewrite first. A solution exceeding ~150 lines needs written justification before continuing.

## Code style — no AI fingerprints

- Never mention AI, assistants, or any model/tool names in code, comments, commit messages, docstrings, or docs. No "Generated by" or "Co-authored-by" attribution lines in commits.
- Comments sparse, explaining why, not what. Delete commented-out code. Concise one-line docstrings only on non-obvious exported functions.
- No emoji anywhere in code, comments, commits, or docs.
- Prettier and ESLint (Shopify flat config) clean before every commit.
- Commit messages short, imperative, conventional as above.

## Boundaries — never do without asking the owner first

- Never delete or rewrite a file wholesale; targeted edits only, and flag destructive changes first.
- Never modify `docs/PRD.md` or `docs/architecture.md` without flagging it; those are the source of truth.
- Never add a dependency or bump a version without approval.
- Ambiguous task → ask, do not assume.
- Two failed attempts at the same fix → stop and explain the problem, the attempts, and the current state. No churning.
- Mid-phase requests not in `docs/PRD.md`: ask whether to (a) add to the current phase, (b) create a new phase, or (c) log to the Backlog in `docs/phases.md`. Never silently absorb scope.
