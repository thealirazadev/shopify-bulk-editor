import type { Job, JobItem } from "@prisma/client";

import { runGraphql } from "./throttle.server";
import type { Throttler, WorkerAdmin } from "./throttle.server";

import db from "~/db.server";
import type { Snapshot } from "~/lib/edit-set";
import { logger } from "~/lib/logger.server";

const APPLY_READ = `#graphql
  query ApplyRead($id: ID!, $ns: String!, $key: String!, $wantMetafield: Boolean!) {
    node(id: $id) {
      ... on Product {
        id
        status
        variants(first: 100) { edges { node { id price } } }
        metafield(namespace: $ns, key: $key) @include(if: $wantMetafield) { value }
      }
    }
  }
`;

const UPDATE_STATUS = `#graphql
  mutation UpdateStatus($input: ProductInput!) {
    productUpdate(input: $input) { product { id } userErrors { field message } }
  }
`;

const ADD_TAGS = `#graphql
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }
`;

const REMOVE_TAGS = `#graphql
  mutation RemoveTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }
`;

const UPDATE_PRICES = `#graphql
  mutation UpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

const SET_METAFIELD = `#graphql
  mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
  }
`;

const DELETE_METAFIELD = `#graphql
  mutation DeleteMetafield($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

interface UserError {
  field?: string[] | null;
  message: string;
}

interface ApplyReadNode {
  node: {
    id: string;
    status: string;
    variants: { edges: { node: { id: string; price: string } }[] };
    metafield: { value: string } | null;
  } | null;
}

function firstError(errors: UserError[] | undefined): string | null {
  if (errors && errors.length > 0) return errors[0].message;
  return null;
}

function metafieldReadVars(before: Snapshot): { ns: string; key: string; wantMetafield: boolean } {
  if (before.metafield) {
    return { ns: before.metafield.namespace, key: before.metafield.key, wantMetafield: true };
  }
  return { ns: "app", key: "unused", wantMetafield: false };
}

// True when the product's live value no longer matches the staged before-value
// for a price/status/metafield edit. Tags are set operations and never stale.
function isStale(before: Snapshot, node: ApplyReadNode["node"]): boolean {
  if (!node) return false;
  if (before.variants) {
    const liveById = new Map(node.variants.edges.map((edge) => [edge.node.id, edge.node.price]));
    for (const variant of before.variants) {
      const live = liveById.get(variant.id);
      if (live === undefined || Number(live) !== Number(variant.price)) return true;
    }
  }
  if (before.status !== undefined && node.status !== before.status) return true;
  if (before.metafield) {
    const liveValue = node.metafield?.value ?? null;
    if (liveValue !== before.metafield.value) return true;
  }
  return false;
}

async function markItem(id: string, status: string, message: string | null): Promise<string> {
  await db.jobItem.update({ where: { id }, data: { status, message } });
  return status;
}

// Apply one item's staged after-values, returning the resulting item status.
// Re-reads the live product for a stale check first (price/status/metafield),
// then runs the needed mutations in order. Any userError fails the item;
// already-applied mutations are noted.
async function applyItem(
  job: Job,
  item: JobItem,
  admin: WorkerAdmin,
  throttle: Throttler,
): Promise<string> {
  if (!item.beforeJson || !item.afterJson) {
    return markItem(item.id, "failed", "Missing staged values.");
  }

  const before = JSON.parse(item.beforeJson) as Snapshot;
  const after = JSON.parse(item.afterJson) as Snapshot;

  const read = await runGraphql<ApplyReadNode>(admin, throttle, "apply_read", APPLY_READ, {
    id: item.productGid,
    ...metafieldReadVars(before),
  });

  if (!read.node) {
    return markItem(item.id, "failed", "Product no longer exists.");
  }
  if (isStale(before, read.node)) {
    return markItem(item.id, "skipped_stale", "Value changed since preview.");
  }

  const applied: string[] = [];

  try {
    if (after.variants) {
      const data = await runGraphql<{ productVariantsBulkUpdate: { userErrors: UserError[] } }>(
        admin,
        throttle,
        "prices",
        UPDATE_PRICES,
        {
          productId: item.productGid,
          variants: after.variants.map((variant) => ({ id: variant.id, price: variant.price })),
        },
      );
      const error = firstError(data.productVariantsBulkUpdate.userErrors);
      if (error) return failItem(item.id, "price", error, applied);
      applied.push("price");
    }

    if (after.status !== undefined) {
      const data = await runGraphql<{ productUpdate: { userErrors: UserError[] } }>(
        admin,
        throttle,
        "status",
        UPDATE_STATUS,
        { input: { id: item.productGid, status: after.status } },
      );
      const error = firstError(data.productUpdate.userErrors);
      if (error) return failItem(item.id, "status", error, applied);
      applied.push("status");
    }

    if (after.tags && before.tags) {
      const added = after.tags.list.filter((entry) => !before.tags!.list.includes(entry));
      const removed = before.tags.list.filter((entry) => !after.tags!.list.includes(entry));
      if (added.length > 0) {
        const data = await runGraphql<{ tagsAdd: { userErrors: UserError[] } }>(
          admin,
          throttle,
          "tags_add",
          ADD_TAGS,
          { id: item.productGid, tags: added },
        );
        const error = firstError(data.tagsAdd.userErrors);
        if (error) return failItem(item.id, "tags", error, applied);
      }
      if (removed.length > 0) {
        const data = await runGraphql<{ tagsRemove: { userErrors: UserError[] } }>(
          admin,
          throttle,
          "tags_remove",
          REMOVE_TAGS,
          { id: item.productGid, tags: removed },
        );
        const error = firstError(data.tagsRemove.userErrors);
        if (error) return failItem(item.id, "tags", error, applied);
      }
      applied.push("tags");
    }

    if (after.metafield) {
      // A null after-value means the product had no metafield before this edit
      // (an undo of a backfill); metafieldsSet requires a non-null value, so the
      // restore is a delete, not a set.
      if (after.metafield.value === null) {
        const data = await runGraphql<{ metafieldsDelete: { userErrors: UserError[] } }>(
          admin,
          throttle,
          "metafield_delete",
          DELETE_METAFIELD,
          {
            metafields: [
              {
                ownerId: item.productGid,
                namespace: after.metafield.namespace,
                key: after.metafield.key,
              },
            ],
          },
        );
        const error = firstError(data.metafieldsDelete.userErrors);
        if (error) return failItem(item.id, "metafield", error, applied);
      } else {
        const data = await runGraphql<{ metafieldsSet: { userErrors: UserError[] } }>(
          admin,
          throttle,
          "metafield",
          SET_METAFIELD,
          {
            metafields: [
              {
                ownerId: item.productGid,
                namespace: after.metafield.namespace,
                key: after.metafield.key,
                type: after.metafield.type,
                value: after.metafield.value,
              },
            ],
          },
        );
        const error = firstError(data.metafieldsSet.userErrors);
        if (error) return failItem(item.id, "metafield", error, applied);
      }
      applied.push("metafield");
    }

    return markItem(item.id, "applied", null);
  } catch (error) {
    logger.error("item mutation failed", {
      shop: job.shop,
      jobId: job.id,
      itemId: item.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return failItem(item.id, "apply", "The update could not be completed.", applied);
  }
}

function failItem(id: string, field: string, message: string, applied: string[]): Promise<string> {
  const suffix = applied.length > 0 ? ` (already applied: ${applied.join(", ")})` : "";
  return markItem(id, "failed", `${field}: ${message}${suffix}`);
}

// Recompute the job's counts from its items. Used to seed live progress at the
// start of a run and to write the authoritative final counts.
async function computeCounts(jobId: string) {
  const grouped = await db.jobItem.groupBy({
    by: ["status"],
    where: { jobId },
    _count: { _all: true },
  });
  const count = (status: string) => grouped.find((row) => row.status === status)?._count._all ?? 0;

  const successCount = count("applied");
  const failedCount = count("failed");
  const skippedCount = count("skipped_stale") + count("skipped_unchanged") + count("invalid");
  return {
    successCount,
    failedCount,
    skippedCount,
    processedCount: successCount + failedCount + skippedCount,
  };
}

async function finalize(jobId: string): Promise<void> {
  const counts = await computeCounts(jobId);
  const status = counts.failedCount > 0 ? "completed_with_errors" : "completed";

  await db.job.updateMany({
    where: { id: jobId, status: "running" },
    data: { ...counts, status, finishedAt: new Date(), heartbeatAt: null },
  });
}

// Apply a queued (or resumed running) job one product at a time. Only pending
// items are processed, so a restart never re-applies an already-applied item.
export async function runApply(job: Job, admin: WorkerAdmin, throttle: Throttler): Promise<void> {
  await db.job.updateMany({
    where: { id: job.id, status: { in: ["queued", "running"] } },
    data: { status: "running", startedAt: job.startedAt ?? new Date(), heartbeatAt: new Date() },
  });

  // Seed live counts (includes staging-time skips and any resumed applies).
  await db.job.updateMany({
    where: { id: job.id, status: "running" },
    data: await computeCounts(job.id),
  });

  const pending = await db.jobItem.findMany({
    where: { jobId: job.id, status: "pending" },
    orderBy: { id: "asc" },
  });

  for (const item of pending) {
    const current = await db.job.findUnique({ where: { id: job.id }, select: { status: true } });
    if (!current || current.status !== "running") {
      // Canceled or interrupted: record final counts without changing status.
      await db.job.updateMany({
        where: { id: job.id, status: "canceled" },
        data: await computeCounts(job.id),
      });
      logger.info("apply loop stopped early", { shop: job.shop, jobId: job.id });
      return;
    }

    const outcome = await applyItem(job, item, admin, throttle);
    await db.job.update({
      where: { id: job.id },
      data: {
        heartbeatAt: new Date(),
        processedCount: { increment: 1 },
        successCount: outcome === "applied" ? { increment: 1 } : undefined,
        failedCount: outcome === "failed" ? { increment: 1 } : undefined,
        skippedCount: outcome === "skipped_stale" ? { increment: 1 } : undefined,
      },
    });
  }

  await finalize(job.id);

  // A completed undo disables a second undo of its original job.
  if (job.type === "undo" && job.undoOfJobId) {
    await db.job.updateMany({
      where: { id: job.undoOfJobId, undoneByJobId: null },
      data: { undoneByJobId: job.id },
    });
  }

  logger.info("apply job finished", { shop: job.shop, jobId: job.id });
}
