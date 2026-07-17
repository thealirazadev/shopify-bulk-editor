// Inverse-edit computation for undo. Pure and unit-tested. An undo restores the
// values the original job overwrote, so each undo item simply swaps the
// original before/after snapshots: the undo writes the old `before` and
// stale-checks against the old `after` (docs/architecture.md).

import type { Snapshot } from "./edit-set";

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
