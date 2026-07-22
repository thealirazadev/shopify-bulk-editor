// Inverse-edit computation for undo. Pure and unit-tested. An undo restores the
// values the original job overwrote, so each undo item simply swaps the
// original before/after snapshots: the undo writes the old `before` and
// stale-checks against the old `after` (docs/architecture.md).

import type { PrismaClient } from "@prisma/client";

import type { Snapshot } from "./edit-set";

// Only user-driven edits and imports are reversible; exports and undos are not.
export const UNDOABLE_JOB_TYPES: ReadonlyArray<string> = ["edit", "csv_import"];
// Terminal statuses whose applied items can be undone (docs/architecture.md).
export const UNDOABLE_JOB_STATUSES: ReadonlyArray<string> = ["completed", "completed_with_errors"];

export interface UndoJobFacts {
  type: string;
  status: string;
  undoneByJobId: string | null;
}

export type UndoEligibility = { canUndo: true } | { canUndo: false; reason: string };

// Single source of truth for whether a job may be undone, shared by the job
// route's loader (to render the button/tooltip) and its action (to guard the
// request). `isLatest` says whether this job is the shop's most recent undoable
// job, resolved against the database by the caller.
export function undoEligibility(job: UndoJobFacts, isLatest: boolean): UndoEligibility {
  if (!UNDOABLE_JOB_TYPES.includes(job.type)) {
    return { canUndo: false, reason: "This job type cannot be undone." };
  }
  if (job.undoneByJobId) {
    return { canUndo: false, reason: "This job was already undone." };
  }
  if (!UNDOABLE_JOB_STATUSES.includes(job.status)) {
    return { canUndo: false, reason: "Only a completed job can be undone." };
  }
  if (!isLatest) {
    return { canUndo: false, reason: "Only the most recent applied job can be undone." };
  }
  return { canUndo: true };
}

// The shop's most recent undoable job id, or null. The Prisma client is passed
// in so this stays free of a hard `db.server` import and remains unit-testable.
export async function latestUndoableJobId(
  db: Pick<PrismaClient, "job">,
  shop: string,
): Promise<string | null> {
  const latest = await db.job.findFirst({
    where: {
      shop,
      type: { in: UNDOABLE_JOB_TYPES as string[] },
      status: { in: UNDOABLE_JOB_STATUSES as string[] },
    },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  return latest?.id ?? null;
}

export interface AppliedItem {
  productGid: string;
  productTitle: string;
  status: string;
  beforeJson: string | null;
  afterJson: string | null;
}

export interface UndoItem {
  productGid: string;
  productTitle: string;
  before: Snapshot;
  after: Snapshot;
}

// Build inverse items from a completed job's items. Only `applied` items are
// reversible; everything else (failed, skipped, invalid) is ignored.
export function computeInverseItems(items: AppliedItem[]): UndoItem[] {
  const out: UndoItem[] = [];

  for (const item of items) {
    if (item.status !== "applied") continue;
    if (!item.beforeJson || !item.afterJson) continue;

    const originalBefore = JSON.parse(item.beforeJson) as Snapshot;
    const originalAfter = JSON.parse(item.afterJson) as Snapshot;

    out.push({
      productGid: item.productGid,
      productTitle: item.productTitle,
      before: originalAfter,
      after: originalBefore,
    });
  }

  return out;
}
