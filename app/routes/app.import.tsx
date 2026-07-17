import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Card, EmptyState, Page } from "@shopify/polaris";

import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return json({});
}

export default function ImportIndex() {
  return (
    <Page title="Import CSV">
      <Card>
        <EmptyState
          heading="Import products from CSV"
          image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
        >
          <p>Upload an edited export to preview and apply changes.</p>
        </EmptyState>
      </Card>
    </Page>
  );
}
