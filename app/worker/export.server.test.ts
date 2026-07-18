import { readFile, rm } from "node:fs/promises";

import type { PrismaClient } from "@prisma/client";
import { parse } from "csv-parse/sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb } from "./test-db";
import { createThrottler } from "./throttle.server";
import type { GraphQLBody, WorkerAdmin } from "./throttle.server";

let db: PrismaClient;
let cleanup: () => Promise<void>;
let completeExportJob: (typeof import("./export.server"))["completeExportJob"];

const JSONL = [
  JSON.stringify({
    id: "gid://shopify/Product/1",
    title: "Blue Shirt",
    handle: "blue-shirt",
    vendor: "Acme",
    status: "ACTIVE",
    tags: ["sale"],
  }),
  JSON.stringify({
    id: "gid://shopify/ProductVariant/11",
    title: "Small",
    price: "10.00",
    __parentId: "gid://shopify/Product/1",
  }),
].join("\n");

const COST = {
  extensions: {
    cost: {
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 100 },
    },
  },
};

function statusAdmin(status: string, url: string | null): WorkerAdmin {
  return {
    graphql: async () => {
      const body: GraphQLBody = {
        data: { node: { id: "gid://op/1", status, errorCode: null, objectCount: 2, url } },
        ...COST,
      };
      return { json: async () => body };
    },
  };
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
  ({ completeExportJob } = await import("./export.server"));
});

afterAll(async () => {
  await cleanup();
});

describe("completeExportJob", () => {
  it("downloads the JSONL, writes CSV, and completes the job", async () => {
    const job = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "export",
        status: "running",
        bulkOperationGid: "gid://op/1",
      },
    });

    await completeExportJob(
      job,
      statusAdmin("COMPLETED", "https://example.test/result.jsonl"),
      createThrottler(),
      async () => JSONL,
    );

    const finished = await db.job.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("completed");
    expect(finished?.resultPath).toBe(`storage/exports/${job.id}.csv`);

    const csv = await readFile(finished!.resultPath!, "utf8");
    const rows = parse(csv, { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].variant_id).toBe("gid://shopify/ProductVariant/11");
    await rm(finished!.resultPath!, { force: true });
  });

  it("is idempotent: a second call does not re-complete", async () => {
    const job = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "export",
        status: "running",
        bulkOperationGid: "gid://op/1",
      },
    });

    const admin = statusAdmin("COMPLETED", null);
    await completeExportJob(job, admin, createThrottler(), async () => "");
    const first = await db.job.findUnique({ where: { id: job.id } });

    // Re-run with the already-completed job snapshot; the guarded transition
    // must not run again.
    await completeExportJob(job, admin, createThrottler(), async () => "");
    const second = await db.job.findUnique({ where: { id: job.id } });

    expect(first?.status).toBe("completed");
    expect(second?.finishedAt?.getTime()).toBe(first?.finishedAt?.getTime());
    await rm(second!.resultPath!, { force: true });
  });

  it("fails the job when the bulk operation failed", async () => {
    const job = await db.job.create({
      data: {
        shop: "test.myshopify.com",
        type: "export",
        status: "running",
        bulkOperationGid: "gid://op/1",
      },
    });

    await completeExportJob(job, statusAdmin("FAILED", null), createThrottler(), async () => "");

    const finished = await db.job.findUnique({ where: { id: job.id } });
    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("UPSTREAM_ERROR");
  });
});
