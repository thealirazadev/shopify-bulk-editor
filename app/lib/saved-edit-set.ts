// Shop-scoped store for reusable named edit-sets. The Prisma client is passed
// in (type-only import) so this module stays runtime-pure and unit-testable,
// matching lib/undo.ts. Saving and loading both go through the existing
// validateEditSet, and nothing here touches a Job: a loaded set only fills the
// builder and must still be staged (previewed) before it can be applied.

import type { PrismaClient } from "@prisma/client";

import { validateEditSet } from "./edit-set";
import type { EditOperation, EditSet } from "./edit-set";

export const EDIT_SET_NAME_MAX = 50;

type EditSetDb = Pick<PrismaClient, "savedEditSet">;

export interface SavedEditSetSummary {
  id: string;
  name: string;
  editSet: EditSet;
  updatedAt: string;
}

export type SaveResult = { ok: true; id: string } | { ok: false; errors: string[] };
export type MutateResult = { ok: true } | { ok: false; errors: string[] };

const NAME_ERROR = `Name must be 1 to ${EDIT_SET_NAME_MAX} characters.`;
const DUPLICATE_ERROR = "An edit-set with that name already exists.";
const NOT_FOUND_ERROR = "That edit-set was not found.";

function cleanName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 1 || name.length > EDIT_SET_NAME_MAX) return null;
  return name;
}

// Read a stored edit-set through the identical validation the builder uses at
// stage time; returns null for unreadable or now-invalid JSON so one bad row
// cannot take a listing page down.
export function parseSavedEditSet(editSetJson: string): EditSet | null {
  let raw: unknown;
  try {
    raw = JSON.parse(editSetJson);
  } catch {
    return null;
  }
  const result = validateEditSet(raw);
  return result.valid ? result.editSet : null;
}

export async function saveEditSet(
  db: EditSetDb,
  shop: string,
  rawName: string,
  rawEditSet: unknown,
): Promise<SaveResult> {
  const name = cleanName(rawName);
  if (!name) return { ok: false, errors: [NAME_ERROR] };

  const validation = validateEditSet(rawEditSet);
  if (!validation.valid) return { ok: false, errors: validation.errors };

  const existing = await db.savedEditSet.findUnique({ where: { shop_name: { shop, name } } });
  if (existing) return { ok: false, errors: [DUPLICATE_ERROR] };

  const saved = await db.savedEditSet.create({
    data: { shop, name, editSetJson: JSON.stringify(validation.editSet) },
  });
  return { ok: true, id: saved.id };
}

// Valid saved sets for a shop, newest change first. Unreadable rows are dropped
// and their ids returned so the caller can log them.
export async function listEditSets(
  db: EditSetDb,
  shop: string,
): Promise<{ sets: SavedEditSetSummary[]; skippedIds: string[] }> {
  const rows = await db.savedEditSet.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
  });

  const sets: SavedEditSetSummary[] = [];
  const skippedIds: string[] = [];
  for (const row of rows) {
    const editSet = parseSavedEditSet(row.editSetJson);
    if (!editSet) {
      skippedIds.push(row.id);
      continue;
    }
    sets.push({ id: row.id, name: row.name, editSet, updatedAt: row.updatedAt.toISOString() });
  }
  return { sets, skippedIds };
}

export async function renameEditSet(
  db: EditSetDb,
  shop: string,
  id: string,
  rawName: string,
): Promise<MutateResult> {
  const name = cleanName(rawName);
  if (!name) return { ok: false, errors: [NAME_ERROR] };

  // Reject a collision with a different row in the same shop; renaming a set to
  // its own current name is allowed.
  const clash = await db.savedEditSet.findUnique({ where: { shop_name: { shop, name } } });
  if (clash && clash.id !== id) return { ok: false, errors: [DUPLICATE_ERROR] };

  const updated = await db.savedEditSet.updateMany({ where: { id, shop }, data: { name } });
  if (updated.count === 0) return { ok: false, errors: [NOT_FOUND_ERROR] };
  return { ok: true };
}

// Idempotent: deleting an absent or other-shop id changes nothing and does not throw.
export async function deleteEditSet(db: EditSetDb, shop: string, id: string): Promise<void> {
  await db.savedEditSet.deleteMany({ where: { id, shop } });
}

function describeOperation(op: EditOperation): string {
  switch (op.field) {
    case "price":
      if (op.op === "set") return `Set price to ${op.value}`;
      if (op.op === "adjust_percent") return `Adjust price by ${op.value}%`;
      return `Adjust price by ${op.value}`;
    case "status":
      return `Set status to ${op.value}`;
    case "tags":
      return op.op === "add" ? `Add tag "${op.value}"` : `Remove tag "${op.value}"`;
    default:
      return `Set metafield ${op.namespace}.${op.key}`;
  }
}

// Human-readable one-line summary for the management list and load dropdown.
export function summarizeEditSet(editSet: EditSet): string {
  return editSet.operations.map(describeOperation).join(", ");
}
