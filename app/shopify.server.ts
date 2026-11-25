import "./lib/env.server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-remix/server";

import db from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL!,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(db),
  distribution: AppDistribution.AppStore,
  // Webhook subscriptions live in shopify.app.toml only (app-specific
  // subscriptions, applied by `shopify app deploy`). Registering the same
  // topics per shop in afterAuth as well would deliver each event twice.
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;
