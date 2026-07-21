import { describe, expect, it } from "vitest";

import {
  computeWaitSeconds,
  createThrottler,
  nextEstimate,
  runGraphql,
  DEFAULT_ESTIMATE,
} from "./throttle.server";
import type { GraphQLBody, WorkerAdmin } from "./throttle.server";

const OK_STATUS = { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 100 };

function respond(body: GraphQLBody): { json: () => Promise<GraphQLBody> } {
  return { json: async () => body };
}

const throttledBody: GraphQLBody = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: { cost: { throttleStatus: OK_STATUS } },
};

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

describe("runGraphql THROTTLED handling", () => {
  it("retries once after a THROTTLED error, then returns the data", async () => {
    let calls = 0;
    const admin: WorkerAdmin = {
      graphql: async () => {
        calls += 1;
        if (calls === 1) return respond(throttledBody);
        return respond({
          data: { ok: true },
          extensions: { cost: { actualQueryCost: 10, throttleStatus: OK_STATUS } },
        });
      },
    };

    const result = await runGraphql<{ ok: boolean }>(
      admin,
      createThrottler(),
      "test",
      "query { ok }",
    );

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("fails the call when THROTTLED persists after the single retry", async () => {
    let calls = 0;
    const admin: WorkerAdmin = {
      graphql: async () => {
        calls += 1;
        return respond(throttledBody);
      },
    };

    await expect(runGraphql(admin, createThrottler(), "test", "query { ok }")).rejects.toThrow(
      /throttl/i,
    );
    expect(calls).toBe(2);
  });
});
