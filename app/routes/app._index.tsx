import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Card, EmptyState, Layout, Page } from "@shopify/polaris";

import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  return json({});
}

export default function ProductsIndex() {
  return (
    <Page title="Products">
      <Layout>
        <Layout.Section>
          <Card>
            <EmptyState
              heading="Product browser"
              image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
            >
              <p>Filter and select products to start a bulk edit.</p>
            </EmptyState>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
