import { describe, expect, it } from "vitest";

import { computeInverseItems } from "./undo";
import type { AppliedItem } from "./undo";

function item(overrides: Partial<AppliedItem>): AppliedItem {
  return {
    productGid: "gid://p/1",
    productTitle: "One",
    status: "applied",
    beforeJson: JSON.stringify({ variants: [{ id: "gid://v/1", price: "10.00" }] }),
    afterJson: JSON.stringify({ variants: [{ id: "gid://v/1", price: "11.00" }] }),
    ...overrides,
  };
}

describe("computeInverseItems", () => {
  it("swaps before and after so the undo restores the prior value", () => {
    const [undo] = computeInverseItems([item({})]);
    expect(undo.after.variants?.[0].price).toBe("10.00");
    expect(undo.before.variants?.[0].price).toBe("11.00");
  });

  it("inverts a tag delta by swapping the lists", () => {
    const tagItem = item({
      beforeJson: JSON.stringify({ tags: { list: ["sale"], delta: ["clearance"] } }),
      afterJson: JSON.stringify({ tags: { list: ["sale", "clearance"], delta: ["clearance"] } }),
    });
    const [undo] = computeInverseItems([tagItem]);
    // apply diffs after-before: removes clearance, adds nothing -> reverses the add.
    expect(undo.before.tags?.list).toEqual(["sale", "clearance"]);
    expect(undo.after.tags?.list).toEqual(["sale"]);
  });

  it("includes only applied items", () => {
    const result = computeInverseItems([
      item({ status: "applied" }),
      item({ status: "failed" }),
      item({ status: "skipped_stale" }),
      item({ status: "skipped_unchanged" }),
    ]);
    expect(result).toHaveLength(1);
  });

  it("ignores items missing snapshots", () => {
    expect(computeInverseItems([item({ beforeJson: null })])).toHaveLength(0);
  });
});
