import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setupTestDb } from "./test-db";
import { createThrottler } from "./throttle.server";
import type { GraphQLBody, WorkerAdmin } from "./throttle.server";

// The worker module imports the Shopify app config for offline sessions; the
// claim logic under test never touches it.
vi.mock("~/shopify.server", () => ({ unauthenticated: {} }));

let db: PrismaClient;
let cleanup: () => Promise<void>;
let claimNextJob: (typeof import("./worker.server"))["claimNextJob"];
let runStaging: (typeof import("./stage.server"))["runStaging"];

const admin: WorkerAdmin = {
  graphql: async () => {
    const body: GraphQLBody = {
      data: {
        nodes: [
          {
            id: "gid://p/1",
            title: "Product 1",
            status: "ACTIVE",
            tags: [],
            variants: { edges: [{ node: { id: "gid://v/1", price: "10.00" } }] },
            metafield: null,
          },
        ],
      },
      extensions: {
        cost: {
          throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 100 },
        },
      },
    };
    return { json: async () => body };
  },
};

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
  ({ claimNextJob } = await import("./worker.server"));
  ({ runStaging } = await import("./stage.server"));
});

afterAll(async () => {
  await cleanup();
});

describe("claimNextJob", () => {
  it("claims an edit job queued after the worker staged it", async () => {
    const job = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "edit",
        status: "staging",
        heartbeatAt: new Date(),
        editSetJson: JSON.stringify({
          operations: [{ field: "price", op: "set", value: "12.00" }],
        }),
        selectionJson: JSON.stringify({ mode: "explicit", productIds: ["gid://p/1"] }),
      },
    });

    await runStaging(job, admin, createThrottler());
    // The apply intent moves staged -> queued and nothing else.
    await db.job.update({ where: { id: job.id }, data: { status: "queued" } });

    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("queued");
  });
});
