import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb } from "../worker/test-db";

import {
  deleteEditSet,
  listEditSets,
  parseSavedEditSet,
  renameEditSet,
  saveEditSet,
  summarizeEditSet,
} from "./saved-edit-set";

let db: PrismaClient;
let cleanup: () => Promise<void>;

const SHOP_A = "a.myshopify.com";
const SHOP_B = "b.myshopify.com";

const CONFIG = {
  operations: [
    { field: "price", op: "adjust_percent", value: "10" },
    { field: "tags", op: "add", value: "sale" },
  ],
};

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  cleanup = setup.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("saved edit-set store", () => {
  it("round-trips a saved config through save and list", async () => {
    const result = await saveEditSet(db, SHOP_A, "Spring sale", CONFIG);
    expect(result.ok).toBe(true);

    const { sets } = await listEditSets(db, SHOP_A);
    const saved = sets.find((set) => set.name === "Spring sale");
    expect(saved?.editSet.operations).toEqual([
      { field: "price", op: "adjust_percent", value: "10" },
      { field: "tags", op: "add", value: "sale" },
    ]);
  });

  it("scopes reads and writes to the shop", async () => {
    const saved = await saveEditSet(db, SHOP_A, "Only A", CONFIG);
    expect(saved.ok).toBe(true);
    const id = saved.ok ? saved.id : "";

    // Shop B sees nothing of shop A and cannot rename or delete shop A's set.
    expect((await listEditSets(db, SHOP_B)).sets).toHaveLength(0);
    expect((await renameEditSet(db, SHOP_B, id, "Hijack")).ok).toBe(false);
    await deleteEditSet(db, SHOP_B, id);

    const stillThere = (await listEditSets(db, SHOP_A)).sets.some((set) => set.id === id);
    expect(stillThere).toBe(true);
  });

  it("rejects an invalid config with the builder's own validation errors", async () => {
    const bad = { operations: [{ field: "price", op: "set", value: "" }] };
    const result = await saveEditSet(db, SHOP_A, "Bad", bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("Price value must be a number.");
  });

  it("parseSavedEditSet runs the same validation as staging", () => {
    expect(parseSavedEditSet(JSON.stringify(CONFIG))?.operations).toHaveLength(2);
    expect(parseSavedEditSet("not json")).toBeNull();
    expect(parseSavedEditSet(JSON.stringify({ operations: [] }))).toBeNull();
  });

  it("refuses a duplicate name within a shop but allows it across shops", async () => {
    expect((await saveEditSet(db, SHOP_A, "Dup", CONFIG)).ok).toBe(true);
    expect((await saveEditSet(db, SHOP_A, "Dup", CONFIG)).ok).toBe(false);
    expect((await saveEditSet(db, SHOP_B, "Dup", CONFIG)).ok).toBe(true);
  });

  it("refuses an empty or over-long name", async () => {
    expect((await saveEditSet(db, SHOP_A, "   ", CONFIG)).ok).toBe(false);
    expect((await saveEditSet(db, SHOP_A, "x".repeat(51), CONFIG)).ok).toBe(false);
  });

  it("renames and refuses a colliding rename", async () => {
    const target = await saveEditSet(db, SHOP_A, "RenameMe", CONFIG);
    const other = await saveEditSet(db, SHOP_A, "Existing", CONFIG);
    expect(target.ok && other.ok).toBe(true);
    const id = target.ok ? target.id : "";

    expect((await renameEditSet(db, SHOP_A, id, "Renamed")).ok).toBe(true);
    expect((await renameEditSet(db, SHOP_A, id, "Existing")).ok).toBe(false);

    const names = (await listEditSets(db, SHOP_A)).sets.map((set) => set.name);
    expect(names).toContain("Renamed");
    expect(names).not.toContain("RenameMe");
  });

  it("deletes and is idempotent", async () => {
    const saved = await saveEditSet(db, SHOP_A, "ToDelete", CONFIG);
    const id = saved.ok ? saved.id : "";
    await deleteEditSet(db, SHOP_A, id);
    await deleteEditSet(db, SHOP_A, id);
    expect((await listEditSets(db, SHOP_A)).sets.some((set) => set.id === id)).toBe(false);
  });

  // Preview-gate guard: the store never touches a Job, so a saved or loaded set
  // cannot bypass the draft -> stage (preview) -> apply pipeline.
  it("saving an edit-set never creates or changes a job", async () => {
    const draft = await db.job.create({ data: { shop: SHOP_A, type: "edit", status: "draft" } });
    const before = await db.job.count({ where: { shop: SHOP_A } });

    await saveEditSet(db, SHOP_A, "GuardCheck", CONFIG);

    expect(await db.job.count({ where: { shop: SHOP_A } })).toBe(before);
    expect((await db.job.findUnique({ where: { id: draft.id } }))?.status).toBe("draft");
  });

  it("summarizes operations for display", () => {
    expect(
      summarizeEditSet({ operations: [{ field: "status", op: "set", value: "ACTIVE" }] }),
    ).toBe("Set status to ACTIVE");
  });
});
