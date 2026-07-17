// Cost-aware pacing from the Admin GraphQL `extensions.cost` block. The pure
// core (computeWaitSeconds, nextEstimate) is unit-tested; the pacer is a thin
// stateful wrapper used by the apply worker. See docs/architecture.md.

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface CostExtension {
  actualQueryCost?: number | null;
  requestedQueryCost?: number | null;
  throttleStatus: ThrottleStatus;
}

// Default assumed cost for an operation before its actual cost is observed.
export const DEFAULT_ESTIMATE = 50;

// Seconds to wait before a call costing `estimate` given the last known budget.
export function computeWaitSeconds(status: ThrottleStatus | null, estimate: number): number {
  if (!status) return 0;
  if (status.currentlyAvailable >= estimate) return 0;
  if (status.restoreRate <= 0) return 0;
  return (estimate - status.currentlyAvailable) / status.restoreRate;
}

// Fold an observed actual cost into the running estimate for an operation.
export function nextEstimate(observed: number | null | undefined): number {
  if (observed == null || observed <= 0) return DEFAULT_ESTIMATE;
  return observed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-run pacer. One worker processes one job at a time, so a single pacer per
// apply run holds all the state it needs.
export function createThrottler() {
  let lastStatus: ThrottleStatus | null = null;
  const estimates = new Map<string, number>();

  return {
    // Sleep if the last known budget cannot cover the next call of `op`.
    async beforeCall(op: string): Promise<void> {
      const estimate = estimates.get(op) ?? DEFAULT_ESTIMATE;
      const waitSeconds = computeWaitSeconds(lastStatus, estimate);
      if (waitSeconds > 0) {
        await sleep(Math.ceil(waitSeconds * 1000));
      }
    },

    // Record the cost block returned by a call so the next call paces itself.
    record(op: string, cost: CostExtension | undefined): void {
      if (!cost) return;
      lastStatus = cost.throttleStatus;
      estimates.set(op, nextEstimate(cost.actualQueryCost));
    },
  };
}

export type Throttler = ReturnType<typeof createThrottler>;
