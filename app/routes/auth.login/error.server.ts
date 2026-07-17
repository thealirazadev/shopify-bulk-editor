import type { LoginError } from "@shopify/shopify-app-remix/server";
import { LoginErrorType } from "@shopify/shopify-app-remix/server";

// Maps the package's login error enum to a friendly field-level message.
export function loginErrorMessage(loginErrors: LoginError | undefined): { shop?: string } {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Enter your shop domain to log in." };
  }

  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "Enter a valid shop domain, for example my-shop.myshopify.com." };
  }

  return {};
}
