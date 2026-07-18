import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { AppProvider, Button, Card, FormLayout, Page, Text, TextField } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { useState } from "react";

import { loginErrorMessage } from "./error.server";

import { login } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const errors = loginErrorMessage(await login(request));

  return json({ errors });
}

export async function action({ request }: ActionFunctionArgs) {
  const errors = loginErrorMessage(await login(request));

  return json({ errors });
}

// Non-embedded shop-domain entry form for starting OAuth manually. Renders
// its own Polaris AppProvider since it sits outside the app.tsx embedded
// layout and has no App Bridge frame.
export default function Login() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const errors = actionData?.errors ?? loaderData.errors;

  return (
    <AppProvider i18n={polarisTranslations}>
      <Page narrowWidth title="Log in">
        <Card>
          <Form method="post">
            <FormLayout>
              <Text as="p">Enter your shop domain to install or reopen the app.</Text>
              <TextField
                label="Shop domain"
                name="shop"
                autoComplete="off"
                value={shop}
                onChange={setShop}
                error={errors?.shop}
                placeholder="my-shop.myshopify.com"
              />
              <Button submit>Log in</Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </AppProvider>
  );
}
