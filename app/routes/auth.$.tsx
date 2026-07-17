import type { LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "~/shopify.server";

// Catch-all that begins and completes OAuth. Delegates entirely to the
// Shopify package; it validates state/nonce and persists the session.
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return null;
}
