// Job and item status/type unions, defined once and shared by the worker and
// the routes. SQLite has no Prisma enums, so these string unions are the
// authoritative allowed values (see docs/architecture.md).

export type JobType = "edit" | "csv_import" | "export" | "undo";

export type JobStatus =
  | "draft"
  | "staging"
  | "staged"
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "canceled"
  | "discarded";

export type JobItemStatus =
  "pending" | "applied" | "failed" | "skipped_stale" | "skipped_unchanged" | "invalid";

// Statuses a worker actively drives forward.
export const WORKABLE_STATUSES: ReadonlyArray<JobStatus> = ["staging", "queued", "running"];

// Statuses that a shop uninstall or cancel should stop.
export const ACTIVE_STATUSES: ReadonlyArray<JobStatus> = [
  "draft",
  "staging",
  "staged",
  "queued",
  "running",
];

const TERMINAL_STATUSES: ReadonlyArray<JobStatus> = [
  "completed",
  "completed_with_errors",
  "failed",
  "canceled",
  "discarded",
];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as ReadonlyArray<string>).includes(status);
}

// The 5,000-item cap on a selection, CSV, or job (docs/api-contracts.md).
export const JOB_ITEM_CAP = 5000;
