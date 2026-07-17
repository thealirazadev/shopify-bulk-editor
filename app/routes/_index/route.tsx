import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// Non-embedded landing route. Shopify opens the app with a shop query param
// even outside the embedded frame; forward straight into OAuth/the embedded
// app so there is no separate marketing page to maintain.
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  return redirect("/auth/login");
}
