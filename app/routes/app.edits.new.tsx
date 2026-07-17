import type { ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";

import db from "~/db.server";
import { apiError, newRequestId } from "~/lib/errors";
import type { ProductFilter } from "~/lib/filters";
import { JOB_ITEM_CAP } from "~/lib/jobs";
import type { Selection } from "~/lib/jobs";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

// Parse and validate a selection payload from the browser.
function parseSelection(raw: string): Selection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const selection = parsed as Record<string, unknown>;

  if (selection.mode === "explicit") {
    const ids = selection.productIds;
    if (!Array.isArray(ids) || ids.length === 0) return null;
    if (!ids.every((id) => typeof id === "string" && id.startsWith("gid://"))) return null;
    return { mode: "explicit", productIds: ids as string[] };
  }

  if (selection.mode === "filter") {
    const filter = selection.filter;
    if (typeof filter !== "object" || filter === null) return null;
    return { mode: "filter", filter: filter as ProductFilter };
  }

  return null;
}

// Action-only: create a draft edit job from a browser selection, then hand off
// to the edit-set builder. No product data is touched here.
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const requestId = newRequestId();
  const formData = await request.formData();
  const selection = parseSelection(String(formData.get("selectionJson") ?? ""));

  if (!selection) {
    return json(
      { error: apiError("INVALID_INPUT", "Select at least one product to edit.", requestId).error },
      { status: 400 },
    );
  }

  if (selection.mode === "explicit" && selection.productIds.length > JOB_ITEM_CAP) {
    return json(
      {
        error: apiError(
          "LIMIT_EXCEEDED",
          `A job can target at most ${JOB_ITEM_CAP} products.`,
          requestId,
        ).error,
      },
      { status: 400 },
    );
  }

  try {
    const jobRow = await db.job.create({
      data: {
        shop: session.shop,
        type: "edit",
        status: "draft",
        selectionJson: JSON.stringify(selection),
      },
    });

    return redirect(`/app/edits/${jobRow.id}`);
  } catch (error) {
    logger.error("failed to create draft edit job", {
      shop: session.shop,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });

    return json(
      { error: apiError("INTERNAL", "Could not start the edit. Try again.", requestId).error },
      { status: 500 },
    );
  }
}
