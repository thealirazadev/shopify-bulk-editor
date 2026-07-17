import { describe, expect, it } from "vitest";

import { validateEditSet } from "./edit-set";

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
