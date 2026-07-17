import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Job } from "@prisma/client";

import { createThrottler, runGraphql } from "./throttle.server";
import type { Throttler, WorkerAdmin } from "./throttle.server";

import db from "~/db.server";
import { jsonlToCsv } from "~/lib/csv.server";
import { compileFilter } from "~/lib/filters";
import type { Selection } from "~/lib/jobs";
import { logger } from "~/lib/logger.server";
import { unauthenticated } from "~/shopify.server";

const EXPORT_DIR = "storage/exports";

const EXPORT_FIELDS =
  "id title handle vendor status tags variants { edges { node { id title price } } }";

const BULK_OP_STATUS = `#graphql
  query BulkOpStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation { id status errorCode objectCount url }
    }
  }
`;

interface BulkOpStatusData {
  node: {
    id: string;
    status: string;
    errorCode: string | null;
    objectCount: number | string | null;
    url: string | null;
  } | null;
}

type Downloader = (url: string) => Promise<string>;

async function defaultDownload(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`JSONL download failed with status ${response.status}`);
  }
  return response.text();
}

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

// Check a running export's BulkOperation and, if it finished, download the
// JSONL, convert to CSV, and complete the job. The final running -> completed
// transition is guarded so the webhook and poller race safely (the loser sees a
// non-running job and does nothing).
export async function completeExportJob(
  job: Job,
  admin: WorkerAdmin,
  throttle: Throttler,
  download: Downloader = defaultDownload,
): Promise<void> {
  if (!job.bulkOperationGid) return;

  const data = await runGraphql<BulkOpStatusData>(admin, throttle, "bulk_status", BULK_OP_STATUS, {
    id: job.bulkOperationGid,
  });
  const operation = data.node;
  if (!operation) return;

  if (operation.status !== "COMPLETED") {
    if (["FAILED", "CANCELED", "EXPIRED"].includes(operation.status)) {
      await failExport(job.id, "UPSTREAM_ERROR", "The export did not complete.");
    }
    return;
  }

  const jsonl = operation.url ? await download(operation.url) : "";
  const csv = jsonlToCsv(jsonl);
  await mkdir(EXPORT_DIR, { recursive: true });
  const resultPath = join(EXPORT_DIR, `${job.id}.csv`);
  await writeFile(resultPath, csv, "utf8");

  const done = await db.job.updateMany({
    where: { id: job.id, status: "running" },
    data: {
      status: "completed",
      resultPath,
      totalItems: Number(operation.objectCount ?? 0),
      finishedAt: new Date(),
      heartbeatAt: null,
    },
  });
  if (done.count > 0) {
    logger.info("export completed", { shop: job.shop, jobId: job.id });
  }
}

// Complete the export identified by a bulk-operation gid (webhook entry point).
export async function completeExportByGid(shop: string, gid: string): Promise<void> {
  const job = await db.job.findFirst({
    where: { shop, type: "export", status: "running", bulkOperationGid: gid },
  });
  if (!job) return;
  const { admin } = await unauthenticated.admin(shop);
  await completeExportJob(job, admin as unknown as WorkerAdmin, createThrottler());
}

// Polling fallback: check every running export for completion.
export async function pollRunningExports(): Promise<void> {
  const jobs = await db.job.findMany({
    where: { type: "export", status: "running", bulkOperationGid: { not: null } },
  });

  for (const job of jobs) {
    try {
      const { admin } = await unauthenticated.admin(job.shop);
      await completeExportJob(job, admin as unknown as WorkerAdmin, createThrottler());
    } catch (error) {
      logger.error("export poll failed", {
        shop: job.shop,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
