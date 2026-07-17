# Design: shopify-bulk-editor

The embedded admin UI is built entirely with Shopify Polaris. The app must feel native inside Shopify Admin; there is no custom visual design work.

## Design source: Polaris tokens, not a hand-rolled theme

- Color, typography, spacing, radius, and shadows all come from Polaris design tokens. No custom palette, font stack, spacing scale, hardcoded hex values, pixel paddings, or font sizes.
- Polaris `AppProvider` wraps the app at the root; styles are imported once there.
- Layout uses Polaris primitives (`Page`, `Layout`, `Card`, `BlockStack`, `InlineStack`, `Box`, `Divider`) rather than custom flex/grid CSS.
- If no token fits a need, treat it as a design question and flag it; never invent a literal value.

## Screens and Polaris components

### Product browser (`app._index.tsx`)
- `Page` titled "Products" with primary action "Bulk edit selected" and secondary actions "Export CSV", "Import CSV".
- `IndexFilters` for the filter bar: `ChoiceList` filters for status and collection, `TextField` filters for vendor, tag, and title. Saved filters appear as `IndexFilters` tabs; saving the current filter uses the built-in save flow with a name field.
- `IndexTable` with row selection (checkbox per row plus select-all-matching), columns: product, status (`Badge`: `success` for ACTIVE, `info` for DRAFT, default for ARCHIVED), vendor, tags (truncated), variants, price range. `Pagination` below.
- Selection summary text ("42 selected" / "All 312 matching selected") above the table.

### Edit set builder (`app.edits.$id.tsx`, job status `draft`)
- `Page` titled "New bulk edit" with subtitle showing the selection size.
- One `Card` per operation row: `Select` for field, `Select` for operation, value inputs (`TextField` with appropriate prefix/suffix, e.g. `%`; `Select` for status; namespace/key/type/value fields for metafield). "Add operation" `Button` (max 4, one per field); remove via plain `Button` with `tone="critical"`.
- Primary action "Preview changes" (submits `stage`); secondary "Discard".
- Field-level validation errors via each input's `error` prop.

### Staging progress (same route, status `staging`)
- `Card` with `ProgressBar` and `Text` ("Preparing preview — 240 of 512 products"), polling every 2 seconds. `Banner` (tone `critical`) with retry guidance if staging fails.

### Preview (same route, status `staged`)
- `Page` titled "Preview changes" with a summary `Banner` (tone `info`): "212 products will change, 3 skipped (already match), 2 invalid".
- `IndexTable` (non-selectable): product, then one column pair per edited field showing before → after (`Text` with `tone="subdued"` for before, regular for after). Invalid rows show a `Badge tone="critical"` and the reason; import previews show the CSV row number and any duplicate-file `Banner` (tone `warning`).
- Item-status filter via `ChoiceList`; `Pagination` at 50 rows.
- Primary action "Apply to N products" (disabled when N = 0), secondary "Discard". Apply confirms via a `Modal` restating the count and fields.

### Job progress and detail (`app.jobs.$id.tsx`)
- `Page` titled by job type and date, status `Badge` (`attention` queued, `info` running, `success` completed, `warning` completed_with_errors, `critical` failed, default canceled/discarded).
- `Card` with `ProgressBar` and live counts (processed / succeeded / failed / skipped), polling while active.
- Results `IndexTable`: product, outcome `Badge`, message; filterable by outcome. Failed and skipped rows always reachable within two clicks of the job page.
- Actions by state: "Cancel" (queued/running, with confirm `Modal`), "Undo this job" (eligible jobs; ineligible state shows a disabled button with explanatory `Tooltip`), "Download CSV" (finished exports).

### Job history (`app.jobs._index.tsx`)
- `IndexTable`: date, type, status `Badge`, items changed, failures. Rows navigate to detail. `Pagination`.

### CSV import (`app.import.tsx`)
- `Page` titled "Import CSV" with a `Card` containing `DropZone` (`.csv` only), the column reference rendered as a Polaris `DataTable`, and an upload `Button` with `loading` state.
- Rejected files (type/size/columns) show a `Banner` (tone `critical`) naming the problem.

### Login page (`auth.login/route.tsx`)
- As in the starter: `Page`, `Card`, `FormLayout`, `TextField` (shop domain), submit `Button`.

### Error and empty states
- Remix `ErrorBoundary` renders a Polaris `Page` + `Banner` (tone `critical`) with a friendly message and a way back.
- `EmptyState` for: no products matched, no saved filters, no jobs yet, preview with zero changes ("Nothing to change — all selected products already match").

## Component states

Every interactive component defines: default, loading (`Button` `loading`, `SkeletonPage`/`SkeletonBodyText` for loaders, `ProgressBar` for jobs), disabled (in-flight submits, ineligible actions with tooltips explaining why), error (field-level via input `error` props; page-level via `Banner`), success (`Toast` for quick confirmations, `Banner` for job outcomes), empty (`EmptyState` as listed above).

Long-running states are first-class here: polling screens must render meaningfully at 0% and 100%, survive a mid-job page refresh, and stop polling on terminal status.

## Accessibility baseline

- Rely on Polaris components for WCAG 2.1 AA contrast, focus states, and semantics; never override focus outlines or reduce contrast.
- Every input has a visible associated label; placeholders are never the only label.
- All actions keyboard-reachable; no focus traps; `Modal` returns focus on close; Polaris default tab order preserved.
- Status changes announced via `Banner`/`Toast`; outcome badges pair color with text ("Failed", "Skipped") — never color alone.
- App Bridge `NavMenu` and navigation APIs for route changes so Admin URL and history stay correct; no raw `<a>` for embedded cross-route navigation.
- Headings use Polaris `Text` variants in logical order: one page title, then section headings.
- Before/after preview cells include visually hidden "was / becomes" text so screen readers announce the direction of change, not just two numbers.
