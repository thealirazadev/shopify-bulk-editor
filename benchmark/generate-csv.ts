// Synthetic import-CSV generator for the parse/validate benchmark. Rows mirror
// the export schema exactly, so the benchmark exercises the real column layout
// and the real per-product aggregation path.

import { CSV_COLUMNS } from "~/lib/csv.server";

export interface GenerateOptions {
  rows: number;
  // Rows are grouped into products so the aggregation and product-level
  // conflict checks run the same way they do on a real exported file.
  variantsPerProduct?: number;
}

export function generateImportCsv({ rows, variantsPerProduct = 2 }: GenerateOptions): string {
  const lines: string[] = [(CSV_COLUMNS as ReadonlyArray<string>).join(",")];

  for (let row = 0; row < rows; row += 1) {
    const product = Math.floor(row / variantsPerProduct) + 1;
    const price = (10 + (row % 90) + (row % 100) / 100).toFixed(2);
    lines.push(
      [
        `gid://shopify/Product/${product}`,
        `gid://shopify/ProductVariant/${row + 1}`,
        `product-handle-${product}`,
        `Product ${product}`,
        `Variant ${row + 1}`,
        `Vendor ${product % 25}`,
        "ACTIVE",
        // Quoted because the tag list contains a comma; product-level values
        // must match across a product's rows or the parser flags a conflict.
        `"sale, season-${product % 12}"`,
        price,
      ].join(","),
    );
  }

  return lines.join("\n");
}
