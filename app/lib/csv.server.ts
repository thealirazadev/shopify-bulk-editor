import { stringify } from "csv-stringify/sync";

// CSV export serialization and (later) import parsing/validation. Uses
// csv-stringify/csv-parse so quoting and escaping are never hand-rolled.

export const CSV_COLUMNS = [
  "product_id",
  "variant_id",
  "handle",
  "product_title",
  "variant_title",
  "vendor",
  "status",
  "tags",
  "price",
] as const;

// Prefix cells that a spreadsheet could read as a formula so they render as
// text (docs/rules.md: CSV formula-injection guard).
export function escapeCsvCell(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

interface BulkProduct {
  id: string;
  title?: string;
  handle?: string;
  vendor?: string | null;
  status?: string;
  tags?: string[];
}

interface BulkVariant {
  id: string;
  title?: string;
  price?: string;
  __parentId?: string;
}

function parseJsonl(jsonl: string): Record<string, unknown>[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Convert a Shopify bulk-operation JSONL result into export CSV. Product lines
// carry scalar fields; variant lines carry `__parentId` pointing at a product.
export function jsonlToCsv(jsonl: string): string {
  const products = new Map<string, BulkProduct>();
  const variants: BulkVariant[] = [];

  for (const node of parseJsonl(jsonl)) {
    const id = String(node.id ?? "");
    if (id.includes("/ProductVariant/")) {
      variants.push(node as unknown as BulkVariant);
    } else if (id.includes("/Product/")) {
      products.set(id, node as unknown as BulkProduct);
    }
  }

  const records = variants.map((variant) => {
    const product = variant.__parentId ? products.get(variant.__parentId) : undefined;
    const cells = [
      product?.id ?? "",
      variant.id,
      product?.handle ?? "",
      product?.title ?? "",
      variant.title ?? "",
      product?.vendor ?? "",
      product?.status ?? "",
      (product?.tags ?? []).join(", "),
      variant.price ?? "",
    ];
    return cells.map(escapeCsvCell);
  });

  return stringify(records, { header: true, columns: CSV_COLUMNS as unknown as string[] });
}
