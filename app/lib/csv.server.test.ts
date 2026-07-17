import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import { escapeCsvCell, jsonlToCsv } from "./csv.server";

describe("escapeCsvCell", () => {
  it("prefixes cells that could be read as a formula", () => {
    expect(escapeCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(escapeCsvCell("+1")).toBe("'+1");
    expect(escapeCsvCell("-1")).toBe("'-1");
    expect(escapeCsvCell("@x")).toBe("'@x");
  });

  it("leaves ordinary cells untouched", () => {
    expect(escapeCsvCell("Blue Shirt")).toBe("Blue Shirt");
    expect(escapeCsvCell("10.00")).toBe("10.00");
  });
});

describe("jsonlToCsv", () => {
  const jsonl = [
    JSON.stringify({
      id: "gid://shopify/Product/1",
      title: "Blue Shirt",
      handle: "blue-shirt",
      vendor: "Acme",
      status: "ACTIVE",
      tags: ["sale", "summer"],
    }),
    JSON.stringify({
      id: "gid://shopify/ProductVariant/11",
      title: "Small",
      price: "10.00",
      __parentId: "gid://shopify/Product/1",
    }),
    JSON.stringify({
      id: "gid://shopify/ProductVariant/12",
      title: "Large",
      price: "14.00",
      __parentId: "gid://shopify/Product/1",
    }),
  ].join("\n");

  it("emits one row per variant joined to its product", () => {
    const rows = parse(jsonlToCsv(jsonl), { columns: true }) as Record<string, string>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      product_id: "gid://shopify/Product/1",
      variant_id: "gid://shopify/ProductVariant/11",
      handle: "blue-shirt",
      product_title: "Blue Shirt",
      variant_title: "Small",
      vendor: "Acme",
      status: "ACTIVE",
      tags: "sale, summer",
      price: "10.00",
    });
    expect(rows[1].variant_id).toBe("gid://shopify/ProductVariant/12");
  });

  it("escapes a product title that starts with an equals sign", () => {
    const injected = [
      JSON.stringify({ id: "gid://shopify/Product/2", title: "=cmd()", tags: [] }),
      JSON.stringify({
        id: "gid://shopify/ProductVariant/21",
        price: "1.00",
        __parentId: "gid://shopify/Product/2",
      }),
    ].join("\n");
    const rows = parse(jsonlToCsv(injected), { columns: true }) as Record<string, string>[];
    expect(rows[0].product_title).toBe("'=cmd()");
  });
});
