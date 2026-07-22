import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

import { JOB_ITEM_CAP } from "./jobs";

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
// text (docs/rules.md: CSV formula-injection guard). Leading tab (0x09) and
// carriage return (0x0D) are triggers too, so they are guarded alongside the
// = + - @ characters.
export function escapeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
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

// ---------------------------------------------------------------------------
// Import parsing and validation. Every row gets a precise `row N, column X`
// message; valid rows aggregate into per-product targets (docs/api-contracts.md).

export interface ImportProduct {
  productGid: string;
  productTitle: string;
  variants: { variantId: string; price: string }[];
  status: string | null;
  tags: string[] | null;
  firstRow: number;
}

export interface ImportInvalidRow {
  csvRow: number;
  message: string;
  productTitle: string;
}

export interface ImportParseResult {
  ok: boolean;
  error?: string;
  products: ImportProduct[];
  invalidRows: ImportInvalidRow[];
  unknownColumns: string[];
  rowCount: number;
}

const KNOWN_COLUMNS = new Set(CSV_COLUMNS as unknown as string[]);
const STATUS_VALUES = ["ACTIVE", "DRAFT", "ARCHIVED"];
// Money with at most two decimal places. Shopify rounds prices to the currency's
// decimal precision, so accepting three-plus decimals here would let the stored
// after-value drift from what the store keeps, breaking later stale/undo checks.
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const OVER_PRECISION = /^\d+\.\d{3,}$/;

function fail(message: string): ImportParseResult {
  return {
    ok: false,
    error: message,
    products: [],
    invalidRows: [],
    unknownColumns: [],
    rowCount: 0,
  };
}

function validTags(raw: string): { tags: string[] } | { error: string } {
  const tags = raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  for (const tag of tags) {
    if (tag.length > 255) return { error: "a tag is longer than 255 characters" };
  }
  return { tags };
}

export function parseImportCsv(content: string): ImportParseResult {
  let rows: string[][];
  try {
    rows = parse(content, { skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch {
    return fail("The file could not be read as CSV.");
  }

  if (rows.length === 0) return fail("The file is empty.");

  const header = rows[0].map((name) => name.trim());
  const index = (name: string) => header.indexOf(name);
  if (index("product_id") === -1 || index("variant_id") === -1) {
    return fail("Missing required column: product_id and variant_id are required.");
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) return fail("The file has no data rows.");
  if (dataRows.length > JOB_ITEM_CAP) {
    return fail(`The file has more than ${JOB_ITEM_CAP} data rows.`);
  }

  const unknownColumns = header.filter((name) => !KNOWN_COLUMNS.has(name));
  const cols = {
    productId: index("product_id"),
    variantId: index("variant_id"),
    productTitle: index("product_title"),
    price: index("price"),
    status: index("status"),
    tags: index("tags"),
  };

  const products = new Map<string, ImportProduct>();
  const invalidRows: ImportInvalidRow[] = [];

  dataRows.forEach((row, idx) => {
    const csvRow = idx + 1;
    const cell = (col: number) => (col >= 0 ? (row[col] ?? "").trim() : "");
    const productGid = cell(cols.productId);
    const variantId = cell(cols.variantId);
    const productTitle = cell(cols.productTitle) || productGid || `Row ${csvRow}`;
    const invalid = (message: string) => invalidRows.push({ csvRow, message, productTitle });

    if (!productGid || !variantId) {
      invalid(`row ${csvRow}, column ${productGid ? "variant_id" : "product_id"}: required`);
      return;
    }

    let price: string | null = null;
    if (cols.price >= 0 && cell(cols.price) !== "") {
      const raw = cell(cols.price);
      if (!AMOUNT.test(raw)) {
        const detail = OVER_PRECISION.test(raw)
          ? "has more than two decimal places"
          : "is not a valid amount";
        invalid(`row ${csvRow}, column price: "${raw}" ${detail}`);
        return;
      }
      price = raw;
    }

    let status: string | null = null;
    if (cols.status >= 0 && cell(cols.status) !== "") {
      const raw = cell(cols.status);
      if (!STATUS_VALUES.includes(raw)) {
        invalid(`row ${csvRow}, column status: "${raw}" is not ACTIVE, DRAFT, or ARCHIVED`);
        return;
      }
      status = raw;
    }

    let tags: string[] | null = null;
    if (cols.tags >= 0) {
      const parsed = validTags(cell(cols.tags));
      if ("error" in parsed) {
        invalid(`row ${csvRow}, column tags: ${parsed.error}`);
        return;
      }
      tags = parsed.tags;
    }

    const existing = products.get(productGid);
    if (!existing) {
      products.set(productGid, {
        productGid,
        productTitle,
        variants: price === null ? [] : [{ variantId, price }],
        status,
        tags,
        firstRow: csvRow,
      });
      return;
    }

    if (status !== null && existing.status !== null && status !== existing.status) {
      invalid(`row ${csvRow}, column status: conflicts with row ${existing.firstRow}`);
      return;
    }
    if (tags !== null && existing.tags !== null && tags.join(",") !== existing.tags.join(",")) {
      invalid(`row ${csvRow}, column tags: conflicts with row ${existing.firstRow}`);
      return;
    }
    if (price !== null) existing.variants.push({ variantId, price });
    if (existing.status === null) existing.status = status;
    if (existing.tags === null) existing.tags = tags;
  });

  return {
    ok: true,
    products: [...products.values()],
    invalidRows,
    unknownColumns,
    rowCount: dataRows.length,
  };
}
