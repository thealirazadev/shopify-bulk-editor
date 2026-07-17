import type { Job } from "@prisma/client";

import { runApply } from "./apply.server";
import { runExportStart } from "./export.server";
import { runStaging } from "./stage.server";
import { createThrottler } from "./throttle.server";
import type { WorkerAdmin } from "./throttle.server";

import { unauthenticated } from "~/shopify.server";
import { logger } from "~/lib/logger.server";
import db from "~/db.server";

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

// Module-level singleton so Vite HMR in dev does not spawn a second loop, the
// same guard pattern as the Prisma client.
declare global {
  // eslint-disable-next-line no-var
  var workerStarted: boolean | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Claim one job that needs active processing: a fresh staging/queued job, or a
// running/staging job whose worker died (stale heartbeat). Optimistic guard on
// the heartbeat so only one claimer wins.
async function claimNextJob(): Promise<Job | null> {
  const staleBefore = new Date(Date.now() - HEARTBEAT_STALE_MS);

  const candidate = await db.job.findFirst({
    where: {
      OR: [
        // Fresh staging/queued work for any type (export only ever starts here).
        { status: { in: ["staging", "queued"] }, heartbeatAt: null },
        // Crash recovery for apply/staging jobs; running exports finish via
        // webhook or the export poller, never by re-claiming.
        {
          type: { in: ["edit", "csv_import", "undo"] },
          status: { in: ["staging", "running"] },
          heartbeatAt: { lt: staleBefore },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
  });

  if (!candidate) return null;

  const claimed = await db.job.updateMany({
    where: { id: candidate.id, heartbeatAt: candidate.heartbeatAt },
    data: { heartbeatAt: new Date() },
  });
  if (claimed.count === 0) return null;

  return db.job.findUnique({ where: { id: candidate.id } });
}

async function adminForShop(shop: string): Promise<WorkerAdmin> {
  const { admin } = await unauthenticated.admin(shop);
  return admin as unknown as WorkerAdmin;
}

async function processJob(job: Job): Promise<void> {
  const throttle = createThrottler();
  const admin = await adminForShop(job.shop);

  if (job.status === "staging") {
    await runStaging(job, admin, throttle);
    return;
  }
  if (job.type === "export") {
    await runExportStart(job, admin, throttle);
    return;
  }
  await runApply(job, admin, throttle);
}

async function tick(): Promise<void> {
  const job = await claimNextJob();
  if (!job) return;

  logger.info("worker claimed job", { shop: job.shop, jobId: job.id, status: job.status });

  try {
    await processJob(job);
  } catch (error) {
    logger.error("job processing failed", {
      shop: job.shop,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await db.job.updateMany({
      where: { id: job.id, status: { in: ["staging", "queued", "running"] } },
      data: {
        status: "failed",
        errorCode: "INTERNAL",
        errorMessage: "The job could not be completed.",
        finishedAt: new Date(),
        heartbeatAt: null,
      },
    });
  }
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await tick();
    } catch (error) {
      logger.error("worker tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Start the background worker once per server process.
export function startWorker(): void {
  if (global.workerStarted) return;
  global.workerStarted = true;
  logger.info("background worker started");
  loop().catch((error) => {
    logger.error("worker loop exited", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
