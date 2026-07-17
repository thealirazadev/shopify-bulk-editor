import { readFile } from "node:fs/promises";

import type { LoaderFunctionArgs } from "@remix-run/node";

import db from "~/db.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

// Authenticated resource route that streams a finished export CSV. The storage
// directory is never web-exposed directly; downloads only happen here.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const job = await db.job.findFirst({
    where: { id: params.id, shop: session.shop, type: "export" },
  });

  if (!job || !job.resultPath) {
    throw new Response("Export not available.", { status: 404 });
  }

  try {
    const content = await readFile(job.resultPath, "utf8");
    return new Response(content, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="products-export-${job.id}.csv"`,
      },
    });
  } catch (error) {
    logger.warn("export download unavailable", {
      shop: session.shop,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Response("This export is no longer available.", { status: 404 });
  }
}
