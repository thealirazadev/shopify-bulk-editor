import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setupTestDb } from "~/worker/test-db";

// Lives outside app/routes so the flat-routes convention does not turn the test
// file into a route.
const webhook = vi.fn();
vi.mock("~/shopify.server", () => ({
  authenticate: { webhook: (request: Request) => webhook(request) },
  unauthenticated: {},
}));

let db: PrismaClient;
let cleanup: () => Promise<void>;
let action: (typeof import("./routes/webhooks"))["action"];
let fileDir: string;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
  ({ action } = await import("./routes/webhooks"));
  fileDir = mkdtempSync(join(tmpdir(), "sbe-exports-"));
});

afterAll(async () => {
  await cleanup();
  rmSync(fileDir, { recursive: true, force: true });
});

describe("webhooks action (SHOP_REDACT)", () => {
  it("deletes the shop's export files along with its rows", async () => {
    const shop = "redact.myshopify.com";
    const resultPath = join(fileDir, "export.csv");
    writeFileSync(resultPath, "id,title\n");
    await db.job.create({
      data: { shop, type: "export", status: "completed", resultPath },
    });
    const otherPath = join(fileDir, "other.csv");
    writeFileSync(otherPath, "id,title\n");
    await db.job.create({
      data: {
        shop: "other.myshopify.com",
        type: "export",
        status: "completed",
        resultPath: otherPath,
      },
    });

    webhook.mockResolvedValueOnce({ topic: "SHOP_REDACT", shop, payload: {} });
    const response = await action({
      request: new Request("https://example.com/webhooks", { method: "POST" }),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
    expect(existsSync(resultPath)).toBe(false);
    expect(existsSync(otherPath)).toBe(true);
    expect(await db.job.count({ where: { shop } })).toBe(0);
  });
});
