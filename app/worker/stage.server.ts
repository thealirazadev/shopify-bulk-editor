import type { Job } from "@prisma/client";

import { runGraphql } from "./throttle.server";
import type { Throttler, WorkerAdmin } from "./throttle.server";

import db from "~/db.server";
import { computeItem, validateEditSet } from "~/lib/edit-set";
import type { EditSet, ItemComputation, ProductState } from "~/lib/edit-set";
import { compileFilter } from "~/lib/filters";
import { JOB_ITEM_CAP } from "~/lib/jobs";
import type { Selection } from "~/lib/jobs";
import { logger } from "~/lib/logger.server";

const STAGE_PAGE_SIZE = 100;
const ID_CHUNK = 50;

const PRODUCT_FIELDS = `
  id
  title
  status
  tags
  variants(first: 100) { edges { node { id price } } }
  metafield(namespace: $ns, key: $key) @include(if: $wantMetafield) { value type }
`;

const STAGE_BY_QUERY = `#graphql
  query StageByQuery($first: Int!, $after: String, $query: String, $ns: String!, $key: String!, $wantMetafield: Boolean!) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      edges { node { ${PRODUCT_FIELDS} } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const STAGE_BY_IDS = `#graphql
  query StageByIds($ids: [ID!]!, $ns: String!, $key: String!, $wantMetafield: Boolean!) {
    nodes(ids: $ids) {
      ... on Product { ${PRODUCT_FIELDS} }
    }
  }
`;

interface RawProduct {
  id: string;
  title: string;
  status: string;
  tags: string[];
  variants: { edges: { node: { id: string; price: string } }[] };
  metafield: { value: string; type: string } | null;
}

interface StagedProduct extends ProductState {
  id: string;
  title: string;
}

interface StageNodesData {
  nodes: (RawProduct | null)[];
}

interface StageQueryData {
  products: {
    edges: { node: RawProduct }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

function toStaged(node: RawProduct): StagedProduct {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    tags: node.tags,
    variants: node.variants.edges.map((edge) => ({ id: edge.node.id, price: edge.node.price })),
    metafield: node.metafield ? { value: node.metafield.value, type: node.metafield.type } : null,
  };
}

function metafieldVars(editSet: EditSet): { ns: string; key: string; wantMetafield: boolean } {
  const op = editSet.operations.find((entry) => entry.field === "metafield");
  if (op && op.field === "metafield") {
    return { ns: op.namespace, key: op.key, wantMetafield: true };
  }
  return { ns: "app", key: "unused", wantMetafield: false };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

// Fetch every targeted product's live state for the selection.
async function fetchTargets(
  selection: Selection,
  editSet: EditSet,
  admin: WorkerAdmin,
  throttle: Throttler,
): Promise<StagedProduct[]> {
  const mf = metafieldVars(editSet);
  const results: StagedProduct[] = [];

  if (selection.mode === "explicit") {
    for (const ids of chunk(selection.productIds, ID_CHUNK)) {
      const data = await runGraphql<StageNodesData>(admin, throttle, "stage_nodes", STAGE_BY_IDS, {
        ids,
        ...mf,
      });
      for (const node of data.nodes) {
        if (node) results.push(toStaged(node));
      }
    }
    return results;
  }

  let after: string | null = null;
  const query = compileFilter(selection.filter);
  do {
    const data: StageQueryData = await runGraphql<StageQueryData>(
      admin,
      throttle,
      "stage_query",
      STAGE_BY_QUERY,
      { first: STAGE_PAGE_SIZE, after, query: query || undefined, ...mf },
    );
    for (const edge of data.products.edges) {
      results.push(toStaged(edge.node));
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (results.length > JOB_ITEM_CAP) break;
  } while (after);

  return results;
}

// Stage an edit job: snapshot before-values, resolve absolute after-values,
// and write one JobItem per targeted product.
export async function runStaging(job: Job, admin: WorkerAdmin, throttle: Throttler): Promise<void> {
  if (job.type !== "edit") {
    throw new Error(`Staging not implemented for job type ${job.type}`);
  }

  const parsed = validateEditSet(JSON.parse(job.editSetJson ?? "null"));
  if (!parsed.valid) {
    await failJob(job.id, "INVALID_INPUT", "The edit set is no longer valid.");
    return;
  }

  const selection = JSON.parse(job.selectionJson ?? "null") as Selection | null;
  if (!selection) {
    await failJob(job.id, "INVALID_INPUT", "The selection is missing.");
    return;
  }

  // Idempotent restart: clear any partially staged items first.
  await db.jobItem.deleteMany({ where: { jobId: job.id } });

  const targets = await fetchTargets(selection, parsed.editSet, admin, throttle);
  if (targets.length > JOB_ITEM_CAP) {
    await failJob(
      job.id,
      "LIMIT_EXCEEDED",
      `Selection resolves to more than ${JOB_ITEM_CAP} products.`,
    );
    return;
  }

  const items = targets.map((target) => {
    const computed: ItemComputation = computeItem(target, parsed.editSet);
    return {
      jobId: job.id,
      productGid: target.id,
      productTitle: target.title,
      beforeJson: JSON.stringify(computed.before),
      afterJson: JSON.stringify(computed.after),
      status: computed.status,
      message: computed.message ?? null,
    };
  });

  if (items.length > 0) {
    await db.jobItem.createMany({ data: items });
  }

  await db.job.updateMany({
    where: { id: job.id, status: "staging" },
    data: { status: "staged", totalItems: items.length, heartbeatAt: new Date() },
  });

  logger.info("staged edit job", { shop: job.shop, jobId: job.id, totalItems: items.length });
}

async function failJob(jobId: string, code: string, message: string): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, status: "staging" },
    data: { status: "failed", errorCode: code, errorMessage: message, finishedAt: new Date() },
  });
}
