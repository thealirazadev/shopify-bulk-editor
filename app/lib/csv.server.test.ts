import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import { escapeCsvCell, jsonlToCsv, parseImportCsv } from "./csv.server";

describe("escapeCsvCell", () => {
  it("prefixes cells that could be read as a formula", () => {
    expect(escapeCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(escapeCsvCell("+1")).toBe("'+1");
    expect(escapeCsvCell("-1")).toBe("'-1");
    expect(escapeCsvCell("@x")).toBe("'@x");
  });

  it("prefixes cells that begin with a tab or carriage return", () => {
    expect(escapeCsvCell("\t=SUM(A1)")).toBe("'\t=SUM(A1)");
    expect(escapeCsvCell("\r=SUM(A1)")).toBe("'\r=SUM(A1)");
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

describe("parseImportCsv", () => {
  const header = "product_id,variant_id,product_title,status,tags,price";

  it("rejects a file missing required columns", () => {
    const result = parseImportCsv("handle,price\nx,1.00");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects a file with no data rows", () => {
    expect(parseImportCsv(header).ok).toBe(false);
  });

  it("aggregates variant rows into one product and validates good rows", () => {
    const csv = [
      header,
      'gid://shopify/Product/1,gid://shopify/ProductVariant/11,Shirt,ACTIVE,"sale, new",10.00',
      'gid://shopify/Product/1,gid://shopify/ProductVariant/12,Shirt,ACTIVE,"sale, new",14.00',
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.products).toHaveLength(1);
    expect(result.products[0].variants).toHaveLength(2);
    expect(result.products[0].tags).toEqual(["sale", "new"]);
    expect(result.invalidRows).toHaveLength(0);
  });

  it("reports a malformed price with row and column, keeping other rows valid", () => {
    const csv = [
      header,
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,Shirt,ACTIVE,sale,10.00",
      "gid://shopify/Product/2,gid://shopify/ProductVariant/21,Hat,ACTIVE,sale,1O.OO",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.products).toHaveLength(1);
    expect(result.invalidRows).toHaveLength(1);
    expect(result.invalidRows[0]).toMatchObject({ csvRow: 2 });
    expect(result.invalidRows[0].message).toContain("row 2, column price");
  });

  it("rejects a price with more than two decimal places", () => {
    const csv = [
      header,
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,Shirt,ACTIVE,sale,10.999",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.products).toHaveLength(0);
    expect(result.invalidRows[0].message).toContain("more than two decimal places");
  });

  it("accepts one- and two-decimal prices", () => {
    const csv = [
      header,
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,Shirt,ACTIVE,sale,10.5",
      "gid://shopify/Product/2,gid://shopify/ProductVariant/21,Hat,ACTIVE,sale,10",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.invalidRows).toHaveLength(0);
    expect(result.products.map((product) => product.variants[0].price)).toEqual(["10.5", "10"]);
  });

  it("reports an invalid status", () => {
    const csv = [
      header,
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,Shirt,SOLD,sale,10.00",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.invalidRows[0].message).toContain("row 1, column status");
  });

  it("flags a product-level conflict on the later row", () => {
    const csv = [
      header,
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,Shirt,ACTIVE,sale,10.00",
      "gid://shopify/Product/1,gid://shopify/ProductVariant/12,Shirt,DRAFT,sale,14.00",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.invalidRows[0].message).toContain("conflicts with row 1");
  });

  it("rejects a file with a duplicated known column", () => {
    const csv = [
      "product_id,variant_id,price,price",
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,10.00,20.00",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Duplicate column");
    expect(result.error).toContain("price");
  });

  it("reports unknown columns as a warning", () => {
    const csv = [
      "product_id,variant_id,price,color",
      "gid://shopify/Product/1,gid://shopify/ProductVariant/11,10.00,blue",
    ].join("\n");
    const result = parseImportCsv(csv);
    expect(result.unknownColumns).toEqual(["color"]);
  });
});
