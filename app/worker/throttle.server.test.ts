import { describe, expect, it } from "vitest";

import { computeWaitSeconds, nextEstimate, DEFAULT_ESTIMATE } from "./throttle.server";

describe("computeWaitSeconds", () => {
  it("does not wait when no status is known yet", () => {
    expect(computeWaitSeconds(null, 50)).toBe(0);
  });

  it("does not wait when the budget already covers the estimate", () => {
    const status = { maximumAvailable: 1000, currentlyAvailable: 200, restoreRate: 100 };
    expect(computeWaitSeconds(status, 50)).toBe(0);
    expect(computeWaitSeconds(status, 200)).toBe(0);
  });

  it("waits for the shortfall divided by the restore rate", () => {
    const status = { maximumAvailable: 1000, currentlyAvailable: 20, restoreRate: 100 };
    // Need 70, have 20, restore 100/s -> (70-20)/100 = 0.5s
    expect(computeWaitSeconds(status, 70)).toBeCloseTo(0.5, 5);
  });

  it("does not divide by a zero restore rate", () => {
    const status = { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 0 };
    expect(computeWaitSeconds(status, 50)).toBe(0);
  });
});

describe("nextEstimate", () => {
  it("falls back to the default when no cost was observed", () => {
    expect(nextEstimate(null)).toBe(DEFAULT_ESTIMATE);
    expect(nextEstimate(undefined)).toBe(DEFAULT_ESTIMATE);
    expect(nextEstimate(0)).toBe(DEFAULT_ESTIMATE);
  });

  it("uses the observed cost when present", () => {
    expect(nextEstimate(12)).toBe(12);
  });
});
