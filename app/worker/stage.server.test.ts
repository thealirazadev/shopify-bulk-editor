import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb } from "./test-db";
import { createThrottler } from "./throttle.server";
import type { GraphQLBody, WorkerAdmin } from "./throttle.server";

let db: PrismaClient;
let cleanup: () => Promise<void>;
let runStaging: (typeof import("./stage.server"))["runStaging"];

interface LiveProduct {
  id: string;
  title: string;
  status: string;
  tags: string[];
  variants: { id: string; price: string }[];
}

const COST = {
  extensions: {
    cost: {
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 100 },
    },
  },
};

function nodesAdmin(products: LiveProduct[]): WorkerAdmin {
  const byId = new Map(products.map((product) => [product.id, product]));
  return {
    graphql: async (query, options) => {
      const vars = (options?.variables ?? {}) as { ids?: string[] };
      let data: Record<string, unknown> = {};
      if (query.includes("StageByIds")) {
        data = {
          nodes: (vars.ids ?? []).map((id) => {
            const product = byId.get(id);
            if (!product) return null;
            return {
              id: product.id,
              title: product.title,
              status: product.status,
              tags: product.tags,
              variants: { edges: product.variants.map((variant) => ({ node: variant })) },
              metafield: null,
            };
          }),
        };
      }
      const body: GraphQLBody = { data, ...COST };
      return { json: async () => body };
    },
  };
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
  ({ runStaging } = await import("./stage.server"));
});

afterAll(async () => {
  await cleanup();
});

describe("runStaging (edit)", () => {
  it("snapshots before-values and computes absolute after-values", async () => {
    const job = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "edit",
        status: "staging",
        editSetJson: JSON.stringify({
          operations: [{ field: "price", op: "adjust_percent", value: "10" }],
        }),
        selectionJson: JSON.stringify({ mode: "explicit", productIds: ["gid://p/1", "gid://p/2"] }),
      },
    });

    const admin = nodesAdmin([
      {
        id: "gid://p/1",
        title: "One",
        status: "ACTIVE",
        tags: [],
        variants: [{ id: "gid://v/1", price: "10.00" }],
      },
      {
        id: "gid://p/2",
        title: "Two",
        status: "ACTIVE",
        tags: [],
        variants: [{ id: "gid://v/2", price: "20.00" }],
      },
    ]);

    await runStaging(job, admin, createThrottler());

    const finished = await db.job.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("staged");
    expect(finished?.totalItems).toBe(2);

    const items = await db.jobItem.findMany({
      where: { jobId: job.id },
      orderBy: { productGid: "asc" },
    });
    const after1 = JSON.parse(items[0].afterJson ?? "{}");
    expect(after1.variants[0].price).toBe("11.00");
    const before1 = JSON.parse(items[0].beforeJson ?? "{}");
    expect(before1.variants[0].price).toBe("10.00");
    expect(items[0].status).toBe("pending");
  });
});

describe("runStaging (csv_import)", () => {
  it("marks rows that already match as skipped_unchanged", async () => {
    const job = await db.job.create({
      data: { shop: "test.myshopify.com", type: "csv_import", status: "staging" },
    });
    await db.jobItem.createMany({
      data: [
        {
          jobId: job.id,
          productGid: "gid://p/10",
          productTitle: "Change",
          status: "pending",
          afterJson: JSON.stringify({ variants: [{ id: "gid://v/10", price: "12.00" }] }),
        },
        {
          jobId: job.id,
          productGid: "gid://p/11",
          productTitle: "Same",
          status: "pending",
          afterJson: JSON.stringify({ variants: [{ id: "gid://v/11", price: "10.00" }] }),
        },
      ],
    });

    const admin = nodesAdmin([
      {
        id: "gid://p/10",
        title: "Change",
        status: "ACTIVE",
        tags: [],
        variants: [{ id: "gid://v/10", price: "10.00" }],
      },
      {
        id: "gid://p/11",
        title: "Same",
        status: "ACTIVE",
        tags: [],
        variants: [{ id: "gid://v/11", price: "10.00" }],
      },
    ]);

    await runStaging(job, admin, createThrottler());

    const change = await db.jobItem.findFirst({
      where: { jobId: job.id, productGid: "gid://p/10" },
    });
    const same = await db.jobItem.findFirst({ where: { jobId: job.id, productGid: "gid://p/11" } });
    expect(change?.status).toBe("pending");
    expect(same?.status).toBe("skipped_unchanged");
    expect((await db.job.findUnique({ where: { id: job.id } }))?.status).toBe("staged");
  });
});
