// Pure mapping from webhook topic to the action it triggers. Kept separate
// from the route so the dispatch table is unit-testable without mocking
// Prisma or the Shopify webhook authenticator.
export type WebhookAction =
  | "uninstall"
  | "update-scope"
  | "bulk-finish"
  | "acknowledge-data-request"
  | "acknowledge-customer-redact"
  | "shop-redact"
  | "unhandled";

const TOPIC_ACTIONS: Record<string, WebhookAction> = {
  APP_UNINSTALLED: "uninstall",
  APP_SCOPES_UPDATE: "update-scope",
  BULK_OPERATIONS_FINISH: "bulk-finish",
  CUSTOMERS_DATA_REQUEST: "acknowledge-data-request",
  CUSTOMERS_REDACT: "acknowledge-customer-redact",
  SHOP_REDACT: "shop-redact",
};

export function actionForTopic(topic: string): WebhookAction {
  return TOPIC_ACTIONS[topic] ?? "unhandled";
}
