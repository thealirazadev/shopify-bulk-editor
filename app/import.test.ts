import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setupTestDb } from "~/worker/test-db";

// Lives outside app/routes so the flat-routes convention does not turn the test
// file into a route.
vi.mock("~/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "import.myshopify.com" } }) },
}));

let db: PrismaClient;
let cleanup: () => Promise<void>;
let action: (typeof import("./routes/app.import"))["action"];

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
  ({ action } = await import("./routes/app.import"));
});

afterAll(async () => {
  await cleanup();
});

function uploadRequest(csv: string): Request {
  const form = new FormData();
  form.append("file", new File([csv], "prices.csv", { type: "text/csv" }));
  return new Request("https://example.com/app/import", { method: "POST", body: form });
}

describe("import action", () => {
  it("never exposes a claimable staging job without its items", async () => {
    // Observe the database right after the job row is written, which is the
    // earliest point the worker could claim it.
    const create = db.job.create.bind(db.job);
    let itemsWhenCreated = -1;
    const spy = vi.spyOn(db.job, "create").mockImplementation((async (
      args: Parameters<typeof create>[0],
    ) => {
      const row = await create(args);
      itemsWhenCreated = await db.jobItem.count({ where: { jobId: row.id } });
      return row;
    }) as unknown as typeof db.job.create);

    try {
      const csv = [
        "product_id,variant_id,price",
        "gid://shopify/Product/1,gid://shopify/ProductVariant/1,12.00",
        "gid://shopify/Product/2,gid://shopify/ProductVariant/2,abc",
      ].join("\n");
      const response = await action({ request: uploadRequest(csv), params: {}, context: {} });
      expect(response.status).toBe(302);
    } finally {
      spy.mockRestore();
    }

    expect(itemsWhenCreated).toBe(2);
    const job = await db.job.findFirst({ where: { shop: "import.myshopify.com" } });
    expect(job?.status).toBe("staging");
    expect(job?.totalItems).toBe(2);
  });
});
