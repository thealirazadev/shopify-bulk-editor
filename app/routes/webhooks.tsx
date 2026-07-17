import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import db from "~/db.server";
import { logger } from "~/lib/logger.server";
import { actionForTopic } from "~/lib/webhook-topics";
import { authenticate } from "~/shopify.server";
import { completeExportByGid } from "~/worker/export.server";

const ACTIVE_JOB_STATUSES = ["queued", "running", "staging", "staged", "draft"];

// Single endpoint for every registered webhook topic. authenticate.webhook
// verifies the HMAC signature before this runs; an invalid signature never
// reaches the dispatch logic below (the package returns 401 itself).
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  logger.info("webhook received", { shop, topic });

  try {
    switch (actionForTopic(topic)) {
      case "uninstall": {
        await db.session.deleteMany({ where: { shop } });
        await db.job.updateMany({
          where: { shop, status: { in: ACTIVE_JOB_STATUSES } },
          data: { status: "canceled" },
        });
        logger.info("cleaned up after uninstall", { shop, topic });
        break;
      }

      case "update-scope": {
        const scopes = (payload as { current?: string[] }).current;

        if (scopes) {
          await db.session.updateMany({ where: { shop }, data: { scope: scopes.join(",") } });
        }

        break;
      }

      case "bulk-finish": {
        const gid = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
        if (gid) {
          await completeExportByGid(shop, gid);
        }
        logger.info("bulk operation finished webhook handled", { shop, topic });
        break;
      }

      case "acknowledge-data-request":
      case "acknowledge-customer-redact": {
        // No customer PII stored by this app; acknowledge the request.
        logger.info("compliance topic acknowledged", { shop, topic });
        break;
      }

      case "shop-redact": {
        const jobs = await db.job.findMany({ where: { shop }, select: { id: true } });
        const jobIds = jobs.map((jobRow) => jobRow.id);

        await db.jobItem.deleteMany({ where: { jobId: { in: jobIds } } });
        await db.job.deleteMany({ where: { shop } });
        await db.savedFilter.deleteMany({ where: { shop } });
        await db.session.deleteMany({ where: { shop } });
        logger.info("deleted all shop data", { shop, topic });
        break;
      }

      default: {
        logger.warn("unhandled webhook topic acknowledged", { shop, topic });
      }
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    logger.error("webhook processing failed", {
      shop,
      topic,
      error: error instanceof Error ? error.message : String(error),
    });

    return json({ error: "processing failed" }, { status: 500 });
  }
}
