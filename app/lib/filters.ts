// Filter object <-> Shopify product search query. Pure and unit-tested; the
// only place a filter becomes a query string. See docs/api-contracts.md.

export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED";

export interface ProductFilter {
  collectionId?: string;
  vendor?: string;
  tag?: string;
  status?: ProductStatus;
  title?: string;
}

const STATUS_VALUES: ReadonlyArray<ProductStatus> = ["ACTIVE", "DRAFT", "ARCHIVED"];

export function isProductStatus(value: string): value is ProductStatus {
  return (STATUS_VALUES as ReadonlyArray<string>).includes(value);
}

// gid://shopify/Collection/42 -> 42
function numericId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

// Single-quote a value and escape backslashes and single quotes so a value
// with spaces or quotes stays one search term.
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Compile a filter into a Shopify products(query:) string. Present fields AND
// together (space-separated terms are ANDed by Shopify search).
export function compileFilter(filter: ProductFilter): string {
  const terms: string[] = [];

  if (filter.collectionId) {
    terms.push(`collection_id:${numericId(filter.collectionId)}`);
  }
  if (filter.vendor && filter.vendor.trim()) {
    terms.push(`vendor:${quote(filter.vendor.trim())}`);
  }
  if (filter.tag && filter.tag.trim()) {
    terms.push(`tag:${quote(filter.tag.trim())}`);
  }
  if (filter.status && isProductStatus(filter.status)) {
    terms.push(`status:${filter.status.toLowerCase()}`);
  }
  if (filter.title && filter.title.trim()) {
    // Strip user asterisks so they cannot break the contains-match pattern,
    // then escape backslashes and single quotes.
    const escaped = filter.title
      .trim()
      .replace(/\*/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
    // Wildcard contains-match; quote the term when it has whitespace so it
    // stays a single term.
    terms.push(/\s/.test(escaped) ? `title:*'${escaped}'*` : `title:*${escaped}*`);
  }

  return terms.join(" ");
}

// Build a filter object from browse query params (all optional).
export function filterFromParams(params: URLSearchParams): ProductFilter {
  const filter: ProductFilter = {};
  const collectionId = params.get("collectionId");
  const vendor = params.get("vendor");
  const tag = params.get("tag");
  const status = params.get("status");
  const title = params.get("title");

  if (collectionId) filter.collectionId = collectionId;
  if (vendor) filter.vendor = vendor;
  if (tag) filter.tag = tag;
  if (status && isProductStatus(status)) filter.status = status;
  if (title) filter.title = title;

  return filter;
}

export function isEmptyFilter(filter: ProductFilter): boolean {
  return !filter.collectionId && !filter.vendor && !filter.tag && !filter.status && !filter.title;
}
