import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Card, EmptyState, Page } from "@shopify/polaris";

import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return json({});
}

export default function JobsIndex() {
  return (
    <Page title="Jobs">
      <Card>
        <EmptyState
          heading="No jobs yet"
          image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
        >
          <p>Bulk edits, imports, and exports you run will appear here.</p>
        </EmptyState>
      </Card>
    </Page>
  );
}
