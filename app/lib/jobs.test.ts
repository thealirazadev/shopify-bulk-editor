import { describe, expect, it } from "vitest";

import { parsePage } from "./jobs";

describe("parsePage", () => {
  it("reads a positive integer page", () => {
    expect(parsePage("3")).toBe(3);
  });

  it("falls back to page 1 for missing or malformed values", () => {
    expect(parsePage(null)).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("1.5")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-2")).toBe(1);
    expect(parsePage("1e400")).toBe(1);
  });
});
