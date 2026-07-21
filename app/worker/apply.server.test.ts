import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb } from "./test-db";
import { createThrottler } from "./throttle.server";
import type { GraphQLBody, WorkerAdmin } from "./throttle.server";

let db: PrismaClient;
let cleanup: () => Promise<void>;
let runApply: (typeof import("./apply.server"))["runApply"];

interface LiveVariant {
  id: string;
  price: string;
}
interface LiveProduct {
  status: string;
  variants: LiveVariant[];
  metafield?: { value: string } | null;
}

const COST = {
  extensions: {
    cost: {
      actualQueryCost: 10,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 100 },
    },
  },
};

// Mock admin whose ApplyRead reflects `live`, and whose status mutation fails
// for the product id in `failStatusFor`.
function makeAdmin(live: Record<string, LiveProduct>, failStatusFor?: string): WorkerAdmin {
  return {
    graphql: async (query, options) => {
      const vars = (options?.variables ?? {}) as Record<string, unknown>;
      let data: Record<string, unknown> = {};

      if (query.includes("ApplyRead")) {
        const product = live[String(vars.id)];
        data = {
          node: product
            ? {
                id: vars.id,
                status: product.status,
                variants: { edges: product.variants.map((variant) => ({ node: variant })) },
                metafield: product.metafield ?? null,
              }
            : null,
        };
      } else if (query.includes("UpdateVariantPrices")) {
        data = { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } };
      } else if (query.includes("UpdateStatus")) {
        const input = vars.input as { id: string };
        const userErrors =
          failStatusFor && input.id === failStatusFor
            ? [{ field: ["status"], message: "Status cannot be changed." }]
            : [];
        data = { productUpdate: { userErrors } };
      } else if (query.includes("AddTags")) {
        data = { tagsAdd: { userErrors: [] } };
      } else if (query.includes("RemoveTags")) {
        data = { tagsRemove: { userErrors: [] } };
      } else if (query.includes("SetMetafield")) {
        data = { metafieldsSet: { userErrors: [] } };
      }

      const body: GraphQLBody = { data, ...COST };
      return { json: async () => body };
    },
  };
}

async function seedPriceItem(jobId: string, productGid: string, variantId: string, price: string) {
  return db.jobItem.create({
    data: {
      jobId,
      productGid,
      productTitle: `Product ${productGid}`,
      status: "pending",
      beforeJson: JSON.stringify({ variants: [{ id: variantId, price: "10.00" }] }),
      afterJson: JSON.stringify({ variants: [{ id: variantId, price }] }),
    },
  });
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
  ({ runApply } = await import("./apply.server"));
});

afterAll(async () => {
  await cleanup();
});

describe("runApply", () => {
  it("applies, stale-skips, and fails items with correct counts", async () => {
    const job = await db.job.create({
      data: { shop: "test.myshopify.com", type: "edit", status: "queued", totalItems: 3 },
    });

    const applied = await seedPriceItem(job.id, "gid://p/1", "gid://v/1", "11.00");
    const stale = await seedPriceItem(job.id, "gid://p/2", "gid://v/2", "11.00");
    const failing = await db.jobItem.create({
      data: {
        jobId: job.id,
        productGid: "gid://p/3",
        productTitle: "Product 3",
        status: "pending",
        beforeJson: JSON.stringify({ status: "ACTIVE" }),
        afterJson: JSON.stringify({ status: "DRAFT" }),
      },
    });

    const admin = makeAdmin(
      {
        "gid://p/1": { status: "ACTIVE", variants: [{ id: "gid://v/1", price: "10.00" }] },
        // live price differs from the staged before-value -> stale
        "gid://p/2": { status: "ACTIVE", variants: [{ id: "gid://v/2", price: "12.00" }] },
        "gid://p/3": { status: "ACTIVE", variants: [] },
      },
      "gid://p/3",
    );

    await runApply(job, admin, createThrottler());

    expect((await db.jobItem.findUnique({ where: { id: applied.id } }))?.status).toBe("applied");
    expect((await db.jobItem.findUnique({ where: { id: stale.id } }))?.status).toBe(
      "skipped_stale",
    );
    expect((await db.jobItem.findUnique({ where: { id: failing.id } }))?.status).toBe("failed");

    const finished = await db.job.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("completed_with_errors");
    expect(finished?.successCount).toBe(1);
    expect(finished?.failedCount).toBe(1);
    expect(finished?.skippedCount).toBe(1);
    expect(
      (finished?.successCount ?? 0) + (finished?.failedCount ?? 0) + (finished?.skippedCount ?? 0),
    ).toBe(3);
  });

  it("completes cleanly when every item succeeds", async () => {
    const job = await db.job.create({
      data: { shop: "test.myshopify.com", type: "edit", status: "queued", totalItems: 1 },
    });
    await seedPriceItem(job.id, "gid://p/10", "gid://v/10", "11.00");
    const admin = makeAdmin({
      "gid://p/10": { status: "ACTIVE", variants: [{ id: "gid://v/10", price: "10.00" }] },
    });

    await runApply(job, admin, createThrottler());

    const finished = await db.job.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("completed");
    expect(finished?.successCount).toBe(1);
  });

  it("resumes without re-processing already applied items", async () => {
    const job = await db.job.create({
      data: { shop: "test.myshopify.com", type: "edit", status: "running", totalItems: 2 },
    });
    const done = await db.jobItem.create({
      data: {
        jobId: job.id,
        productGid: "gid://p/20",
        productTitle: "Done",
        status: "applied",
        beforeJson: JSON.stringify({ variants: [{ id: "gid://v/20", price: "10.00" }] }),
        afterJson: JSON.stringify({ variants: [{ id: "gid://v/20", price: "11.00" }] }),
      },
    });
    const pending = await seedPriceItem(job.id, "gid://p/21", "gid://v/21", "11.00");

    let readCount = 0;
    const base = makeAdmin({
      "gid://p/21": { status: "ACTIVE", variants: [{ id: "gid://v/21", price: "10.00" }] },
    });
    const admin: WorkerAdmin = {
      graphql: async (query, options) => {
        if (query.includes("ApplyRead")) {
          const vars = (options?.variables ?? {}) as Record<string, unknown>;
          readCount += 1;
          // The already-applied product must never be re-read.
          expect(vars.id).not.toBe("gid://p/20");
        }
        return base.graphql(query, options);
      },
    };

    await runApply(job, admin, createThrottler());

    expect(readCount).toBe(1);
    expect((await db.jobItem.findUnique({ where: { id: done.id } }))?.status).toBe("applied");
    expect((await db.jobItem.findUnique({ where: { id: pending.id } }))?.status).toBe("applied");

    const finished = await db.job.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("completed");
    expect(finished?.successCount).toBe(2);
  });
});

describe("runApply (undo)", () => {
  it("restores prior values and marks the original job undone", async () => {
    const original = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "edit",
        status: "completed",
        totalItems: 1,
        successCount: 1,
      },
    });
    const undoJob = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "undo",
        status: "queued",
        undoOfJobId: original.id,
        totalItems: 1,
      },
    });
    // Undo item: restore price 10.00 (before), stale-check against 11.00 (after).
    const undoItem = await db.jobItem.create({
      data: {
        jobId: undoJob.id,
        productGid: "gid://p/30",
        productTitle: "Undo me",
        status: "pending",
        beforeJson: JSON.stringify({ variants: [{ id: "gid://v/30", price: "11.00" }] }),
        afterJson: JSON.stringify({ variants: [{ id: "gid://v/30", price: "10.00" }] }),
      },
    });

    const admin = makeAdmin({
      "gid://p/30": { status: "ACTIVE", variants: [{ id: "gid://v/30", price: "11.00" }] },
    });

    await runApply(undoJob, admin, createThrottler());

    expect((await db.jobItem.findUnique({ where: { id: undoItem.id } }))?.status).toBe("applied");
    const originalAfter = await db.job.findUnique({ where: { id: original.id } });
    expect(originalAfter?.undoneByJobId).toBe(undoJob.id);
  });

  it("deletes the metafield when undo restores a previously-absent value", async () => {
    const undoJob = await db.job.create({
      data: { shop: "test.myshopify.com", type: "undo", status: "queued", totalItems: 1 },
    });
    // Original edit set a metafield on a product that had none; the undo's
    // after-value is therefore null and must delete the metafield, not set null.
    const undoItem = await db.jobItem.create({
      data: {
        jobId: undoJob.id,
        productGid: "gid://p/32",
        productTitle: "Backfilled",
        status: "pending",
        beforeJson: JSON.stringify({
          metafield: {
            namespace: "custom",
            key: "badge",
            type: "single_line_text_field",
            value: "New",
          },
        }),
        afterJson: JSON.stringify({
          metafield: {
            namespace: "custom",
            key: "badge",
            type: "single_line_text_field",
            value: null,
          },
        }),
      },
    });

    const calls: string[] = [];
    const base = makeAdmin({
      "gid://p/32": { status: "ACTIVE", variants: [], metafield: { value: "New" } },
    });
    const admin: WorkerAdmin = {
      graphql: async (query, options) => {
        if (query.includes("SetMetafield")) calls.push("set");
        if (query.includes("DeleteMetafield")) calls.push("delete");
        if (query.includes("DeleteMetafield")) {
          return {
            json: async () => ({
              data: { metafieldsDelete: { deletedMetafields: [{ key: "badge" }], userErrors: [] } },
              ...COST,
            }),
          };
        }
        return base.graphql(query, options);
      },
    };

    await runApply(undoJob, admin, createThrottler());

    expect((await db.jobItem.findUnique({ where: { id: undoItem.id } }))?.status).toBe("applied");
    expect(calls).toEqual(["delete"]);
  });

  it("skips an undo item whose live value changed since the original apply", async () => {
    const undoJob = await db.job.create({
      data: { shop: "test.myshopify.com", type: "undo", status: "queued", totalItems: 1 },
    });
    const undoItem = await db.jobItem.create({
      data: {
        jobId: undoJob.id,
        productGid: "gid://p/31",
        productTitle: "Changed",
        status: "pending",
        beforeJson: JSON.stringify({ variants: [{ id: "gid://v/31", price: "11.00" }] }),
        afterJson: JSON.stringify({ variants: [{ id: "gid://v/31", price: "10.00" }] }),
      },
    });
    // Live price is neither the original after we set (11.00): a manual change.
    const admin = makeAdmin({
      "gid://p/31": { status: "ACTIVE", variants: [{ id: "gid://v/31", price: "9.00" }] },
    });

    await runApply(undoJob, admin, createThrottler());

    expect((await db.jobItem.findUnique({ where: { id: undoItem.id } }))?.status).toBe(
      "skipped_stale",
    );
  });
});

describe("runApply (cancel)", () => {
  it("applies nothing when the job is already canceled", async () => {
    const job = await db.job.create({
      data: { shop: "test.myshopify.com", type: "edit", status: "canceled", totalItems: 1 },
    });
    const item = await seedPriceItem(job.id, "gid://p/40", "gid://v/40", "11.00");
    const admin = makeAdmin({
      "gid://p/40": { status: "ACTIVE", variants: [{ id: "gid://v/40", price: "10.00" }] },
    });

    await runApply(job, admin, createThrottler());

    expect((await db.jobItem.findUnique({ where: { id: item.id } }))?.status).toBe("pending");
    expect((await db.job.findUnique({ where: { id: job.id } }))?.status).toBe("canceled");
  });

  it("reconciles final counts to the item aggregate when canceled on the last item", async () => {
    const job = await db.job.create({
      data: { shop: "test.myshopify.com", type: "edit", status: "running", totalItems: 1 },
    });
    await seedPriceItem(job.id, "gid://p/41", "gid://v/41", "11.00");

    // Simulate the cancel action landing while this (final) item's mutation is in
    // flight: it sets the job to canceled and writes counts that already include
    // the item. The per-item increment must not then double-count it.
    const base = makeAdmin({
      "gid://p/41": { status: "ACTIVE", variants: [{ id: "gid://v/41", price: "10.00" }] },
    });
    const admin: WorkerAdmin = {
      graphql: async (query, options) => {
        const result = await base.graphql(query, options);
        if (query.includes("UpdateVariantPrices")) {
          await db.job.update({
            where: { id: job.id },
            data: {
              status: "canceled",
              finishedAt: new Date(),
              processedCount: 1,
              successCount: 1,
            },
          });
        }
        return result;
      },
    };

    await runApply(job, admin, createThrottler());

    const finished = await db.job.findUnique({ where: { id: job.id } });
    const appliedCount = await db.jobItem.count({ where: { jobId: job.id, status: "applied" } });
    expect(finished?.status).toBe("canceled");
    expect(appliedCount).toBe(1);
    expect(finished?.successCount).toBe(1);
    expect(finished?.processedCount).toBe(1);
  });
});
