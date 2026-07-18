import { describe, expect, it } from "vitest";

import { actionForTopic } from "./webhook-topics";

describe("actionForTopic", () => {
  it("maps every registered lifecycle, bulk, and compliance topic", () => {
    expect(actionForTopic("APP_UNINSTALLED")).toBe("uninstall");
    expect(actionForTopic("APP_SCOPES_UPDATE")).toBe("update-scope");
    expect(actionForTopic("BULK_OPERATIONS_FINISH")).toBe("bulk-finish");
    expect(actionForTopic("CUSTOMERS_DATA_REQUEST")).toBe("acknowledge-data-request");
    expect(actionForTopic("CUSTOMERS_REDACT")).toBe("acknowledge-customer-redact");
    expect(actionForTopic("SHOP_REDACT")).toBe("shop-redact");
  });

  it("falls back to unhandled for an unknown topic", () => {
    expect(actionForTopic("ORDERS_CREATE")).toBe("unhandled");
  });
});
