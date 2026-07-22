import { describe, expect, it } from "vitest";

import { computeItem } from "./edit-set";
import type { EditSet, ProductState } from "./edit-set";
import { computeInverseItems } from "./undo";
import type { AppliedItem, UndoItem } from "./undo";

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

// Prove the inverse computation round-trips exactly for every edit type: stage
// an edit against a live product state, treat its computed snapshots as the
// applied item, invert it, and confirm the undo writes back the original values.
describe("computeInverseItems round-trips every edit type", () => {
  function state(overrides: Partial<ProductState> = {}): ProductState {
    return {
      status: "ACTIVE",
      tags: ["sale"],
      variants: [{ id: "gid://v/1", price: "10.00" }],
      metafield: null,
      ...overrides,
    };
  }

  // Stage the edit, then invert the (applied) result the way the worker would.
  function roundTrip(current: ProductState, editSet: EditSet): UndoItem {
    const computed = computeItem(current, editSet);
    const [undo] = computeInverseItems([
      {
        productGid: "gid://p/1",
        productTitle: "Product",
        status: "applied",
        beforeJson: JSON.stringify(computed.before),
        afterJson: JSON.stringify(computed.after),
      },
    ]);
    return undo;
  }

  it("price set restores the prior price", () => {
    const undo = roundTrip(state(), { operations: [{ field: "price", op: "set", value: "9" }] });
    expect(undo.after.variants).toEqual([{ id: "gid://v/1", price: "10.00" }]);
    expect(undo.before.variants).toEqual([{ id: "gid://v/1", price: "9.00" }]);
  });

  it("price adjust_percent restores the prior price", () => {
    const undo = roundTrip(state(), {
      operations: [{ field: "price", op: "adjust_percent", value: "10" }],
    });
    expect(undo.after.variants).toEqual([{ id: "gid://v/1", price: "10.00" }]);
    expect(undo.before.variants).toEqual([{ id: "gid://v/1", price: "11.00" }]);
  });

  it("status restores the prior status", () => {
    const undo = roundTrip(state(), {
      operations: [{ field: "status", op: "set", value: "DRAFT" }],
    });
    expect(undo.after.status).toBe("ACTIVE");
    expect(undo.before.status).toBe("DRAFT");
  });

  it("tag add reverses to a removal that restores the original list", () => {
    const undo = roundTrip(state(), {
      operations: [{ field: "tags", op: "add", value: "clearance" }],
    });
    // The worker diffs after-list minus before-list; here that removes clearance.
    const added = undo.after.tags!.list.filter((tag) => !undo.before.tags!.list.includes(tag));
    const removed = undo.before.tags!.list.filter((tag) => !undo.after.tags!.list.includes(tag));
    expect(added).toEqual([]);
    expect(removed).toEqual(["clearance"]);
    expect(undo.after.tags!.list).toEqual(["sale"]);
  });

  it("tag remove reverses to an addition that restores the original list", () => {
    const undo = roundTrip(state({ tags: ["sale", "clearance"] }), {
      operations: [{ field: "tags", op: "remove", value: "clearance" }],
    });
    const added = undo.after.tags!.list.filter((tag) => !undo.before.tags!.list.includes(tag));
    const removed = undo.before.tags!.list.filter((tag) => !undo.after.tags!.list.includes(tag));
    expect(added).toEqual(["clearance"]);
    expect(removed).toEqual([]);
    expect(undo.after.tags!.list).toEqual(["sale", "clearance"]);
  });

  it("metafield set restores the prior value", () => {
    const undo = roundTrip(state({ metafield: { value: "Old", type: "single_line_text_field" } }), {
      operations: [
        {
          field: "metafield",
          op: "set",
          namespace: "custom",
          key: "badge",
          type: "single_line_text_field",
          value: "New",
        },
      ],
    });
    expect(undo.after.metafield?.value).toBe("Old");
    expect(undo.before.metafield?.value).toBe("New");
  });

  it("metafield set on an absent value inverts to a delete (null after)", () => {
    const undo = roundTrip(state({ metafield: null }), {
      operations: [
        {
          field: "metafield",
          op: "set",
          namespace: "custom",
          key: "badge",
          type: "single_line_text_field",
          value: "New",
        },
      ],
    });
    // A null after-value signals the worker to delete rather than set the metafield.
    expect(undo.after.metafield?.value).toBeNull();
    expect(undo.before.metafield?.value).toBe("New");
  });
});
