import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";

// Spin up an isolated SQLite database for an integration test run. Sets
// DATABASE_URL, pushes the schema, and dynamically imports the shared Prisma
// client so the singleton binds to the throwaway file (docs/testing.md).
export async function setupTestDb(): Promise<{
  db: PrismaClient;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "sbe-test-"));
  const dbPath = join(dir, "test.sqlite");
  const url = `file:${dbPath}`;
  process.env.DATABASE_URL = url;

  execSync("./node_modules/.bin/prisma db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });

  const db = (await import("~/db.server")).default;

  return {
    db,
    async cleanup() {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
