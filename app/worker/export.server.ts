import type { Job } from "@prisma/client";

import { runGraphql } from "./throttle.server";
import type { Throttler, WorkerAdmin } from "./throttle.server";

import db from "~/db.server";
import { compileFilter } from "~/lib/filters";
import type { Selection } from "~/lib/jobs";
import { logger } from "~/lib/logger.server";

const EXPORT_FIELDS =
  "id title handle vendor status tags variants { edges { node { id title price } } }";

const START_EXPORT = `#graphql
  mutation StartExport($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

interface StartExportData {
  bulkOperationRunQuery: {
    bulkOperation: { id: string; status: string } | null;
    userErrors: { field?: string[] | null; message: string }[];
  };
}

async function failExport(jobId: string, code: string, message: string): Promise<void> {
  await db.job.updateMany({
    where: { id: jobId, status: { in: ["queued", "running"] } },
    data: { status: "failed", errorCode: code, errorMessage: message, finishedAt: new Date() },
  });
}

// Build the bulk-operation query document for the export's filter.
function buildExportQuery(job: Job): string {
  const selection = job.selectionJson ? (JSON.parse(job.selectionJson) as Selection) : null;
  const filterQuery =
    selection && selection.mode === "filter" ? compileFilter(selection.filter) : "";
  const products = filterQuery ? `products(query: ${JSON.stringify(filterQuery)})` : "products";
  return `{ ${products} { edges { node { ${EXPORT_FIELDS} } } } }`;
}

// Start a bulk query export. On success the job holds the BulkOperation gid and
// moves to running; completion arrives via webhook or the polling fallback.
export async function runExportStart(
  job: Job,
  admin: WorkerAdmin,
  throttle: Throttler,
): Promise<void> {
  const data = await runGraphql<StartExportData>(admin, throttle, "start_export", START_EXPORT, {
    query: buildExportQuery(job),
  });

  const { userErrors, bulkOperation } = data.bulkOperationRunQuery;
  if (userErrors.length > 0 || !bulkOperation) {
    const message = userErrors[0]?.message?.toLowerCase().includes("already")
      ? "Another export is already in progress. Try again shortly."
      : "Could not start the export.";
    logger.warn("export start rejected", {
      shop: job.shop,
      jobId: job.id,
      error: userErrors[0]?.message,
    });
    await failExport(job.id, "UPSTREAM_ERROR", message);
    return;
  }

  await db.job.updateMany({
    where: { id: job.id, status: "queued" },
    data: {
      status: "running",
      bulkOperationGid: bulkOperation.id,
      startedAt: new Date(),
      heartbeatAt: new Date(),
    },
  });
  logger.info("export started", {
    shop: job.shop,
    jobId: job.id,
    bulkOperationGid: bulkOperation.id,
  });
}
