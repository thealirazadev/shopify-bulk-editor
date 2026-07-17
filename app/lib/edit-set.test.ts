import { describe, expect, it } from "vitest";

import { applyTagOp, computeItem, roundHalfUp2, validateEditSet } from "./edit-set";
import type { EditSet, ProductState } from "./edit-set";

function state(overrides: Partial<ProductState> = {}): ProductState {
  return {
    status: "ACTIVE",
    tags: ["sale"],
    variants: [{ id: "gid://shopify/ProductVariant/1", price: "10.00" }],
    metafield: null,
    ...overrides,
  };
}

function set(operations: EditSet["operations"]): EditSet {
  return { operations };
}

describe("validateEditSet", () => {
  it("accepts a valid multi-field edit set", () => {
    const result = validateEditSet({
      operations: [
        { field: "price", op: "adjust_percent", value: "10" },
        { field: "status", op: "set", value: "DRAFT" },
        { field: "tags", op: "add", value: "clearance" },
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
    expect(result.valid).toBe(true);
  });

  it("rejects an empty or oversized operation list", () => {
    expect(validateEditSet({ operations: [] }).valid).toBe(false);
    const five = Array.from({ length: 5 }, () => ({ field: "tags", op: "add", value: "x" }));
    expect(validateEditSet({ operations: five }).valid).toBe(false);
  });

  it("rejects a non-object or missing operations", () => {
    expect(validateEditSet(null).valid).toBe(false);
    expect(validateEditSet({}).valid).toBe(false);
  });

  it("rejects more than one operation per field", () => {
    const result = validateEditSet({
      operations: [
        { field: "price", op: "set", value: "1" },
        { field: "price", op: "adjust_percent", value: "10" },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("enforces the percent adjustment range", () => {
    expect(
      validateEditSet({ operations: [{ field: "price", op: "adjust_percent", value: "1500" }] })
        .valid,
    ).toBe(false);
    expect(
      validateEditSet({ operations: [{ field: "price", op: "adjust_percent", value: "-99" }] })
        .valid,
    ).toBe(true);
    expect(
      validateEditSet({ operations: [{ field: "price", op: "adjust_percent", value: "-100" }] })
        .valid,
    ).toBe(false);
  });

  it("rejects a negative price set and a non-numeric price", () => {
    expect(
      validateEditSet({ operations: [{ field: "price", op: "set", value: "-1" }] }).valid,
    ).toBe(false);
    expect(
      validateEditSet({ operations: [{ field: "price", op: "set", value: "abc" }] }).valid,
    ).toBe(false);
  });

  it("allows a negative adjust_amount (negative result flagged later at staging)", () => {
    expect(
      validateEditSet({ operations: [{ field: "price", op: "adjust_amount", value: "-5" }] }).valid,
    ).toBe(true);
  });

  it("validates status values", () => {
    expect(
      validateEditSet({ operations: [{ field: "status", op: "set", value: "SOLD" }] }).valid,
    ).toBe(false);
    expect(
      validateEditSet({ operations: [{ field: "status", op: "set", value: "ARCHIVED" }] }).valid,
    ).toBe(true);
  });

  it("rejects tags with commas or bad length", () => {
    expect(
      validateEditSet({ operations: [{ field: "tags", op: "add", value: "a,b" }] }).valid,
    ).toBe(false);
    expect(validateEditSet({ operations: [{ field: "tags", op: "add", value: "" }] }).valid).toBe(
      false,
    );
    expect(
      validateEditSet({ operations: [{ field: "tags", op: "remove", value: "sale" }] }).valid,
    ).toBe(true);
  });

  it("validates metafield namespace, key, type, and value", () => {
    const base = { field: "metafield", op: "set", namespace: "custom", key: "badge" };
    expect(
      validateEditSet({ operations: [{ ...base, type: "number_integer", value: "12" }] }).valid,
    ).toBe(true);
    expect(
      validateEditSet({ operations: [{ ...base, type: "number_integer", value: "1.5" }] }).valid,
    ).toBe(false);
    expect(
      validateEditSet({ operations: [{ ...base, type: "boolean", value: "yes" }] }).valid,
    ).toBe(false);
    expect(
      validateEditSet({ operations: [{ ...base, type: "boolean", value: "true" }] }).valid,
    ).toBe(true);
    expect(
      validateEditSet({ operations: [{ ...base, key: "x", type: "number_decimal", value: "1.5" }] })
        .valid,
    ).toBe(false);
  });
});

describe("roundHalfUp2", () => {
  it("rounds half up to two decimals", () => {
    expect(roundHalfUp2(10.005)).toBe(10.01);
    expect(roundHalfUp2(21.989)).toBe(21.99);
    expect(roundHalfUp2(10)).toBe(10);
    expect(roundHalfUp2(0)).toBe(0);
  });
});

describe("computeItem price math", () => {
  it("resolves a percent adjustment to an absolute 2-decimal price", () => {
    const result = computeItem(
      state(),
      set([{ field: "price", op: "adjust_percent", value: "10" }]),
    );
    expect(result.status).toBe("pending");
    expect(result.after.variants).toEqual([
      { id: "gid://shopify/ProductVariant/1", price: "11.00" },
    ]);
    expect(result.before.variants).toEqual([
      { id: "gid://shopify/ProductVariant/1", price: "10.00" },
    ]);
  });

  it("resolves a fixed amount and a set", () => {
    expect(
      computeItem(state(), set([{ field: "price", op: "adjust_amount", value: "2.5" }])).after
        .variants,
    ).toEqual([{ id: "gid://shopify/ProductVariant/1", price: "12.50" }]);
    expect(
      computeItem(state(), set([{ field: "price", op: "set", value: "9" }])).after.variants,
    ).toEqual([{ id: "gid://shopify/ProductVariant/1", price: "9.00" }]);
  });

  it("flags a negative resulting price as invalid", () => {
    const result = computeItem(
      state(),
      set([{ field: "price", op: "adjust_amount", value: "-15" }]),
    );
    expect(result.status).toBe("invalid");
    expect(result.message).toContain("negative");
  });

  it("marks an unchanged price edit skipped_unchanged", () => {
    const result = computeItem(state(), set([{ field: "price", op: "set", value: "10" }]));
    expect(result.status).toBe("skipped_unchanged");
  });
});

describe("computeItem tags", () => {
  it("adds a new tag and records the delta", () => {
    const result = computeItem(state(), set([{ field: "tags", op: "add", value: "clearance" }]));
    expect(result.status).toBe("pending");
    expect(result.after.tags).toEqual({ list: ["sale", "clearance"], delta: ["clearance"] });
  });

  it("skips adding an existing tag as unchanged", () => {
    const result = computeItem(state(), set([{ field: "tags", op: "add", value: "sale" }]));
    expect(result.status).toBe("skipped_unchanged");
    expect(result.after.tags?.delta).toEqual([]);
  });

  it("removes a present tag and skips an absent removal", () => {
    expect(applyTagOp(["sale", "new"], "remove", "sale")).toEqual({
      list: ["new"],
      delta: ["sale"],
    });
    expect(applyTagOp(["new"], "remove", "sale")).toEqual({ list: ["new"], delta: [] });
  });
});

describe("computeItem status and metafield", () => {
  it("computes a status change and its before value", () => {
    const result = computeItem(state(), set([{ field: "status", op: "set", value: "DRAFT" }]));
    expect(result.status).toBe("pending");
    expect(result.before.status).toBe("ACTIVE");
    expect(result.after.status).toBe("DRAFT");
  });

  it("captures the prior metafield value (null when absent)", () => {
    const result = computeItem(
      state(),
      set([
        {
          field: "metafield",
          op: "set",
          namespace: "custom",
          key: "badge",
          type: "single_line_text_field",
          value: "New",
        },
      ]),
    );
    expect(result.before.metafield?.value).toBeNull();
    expect(result.after.metafield?.value).toBe("New");
  });
});
