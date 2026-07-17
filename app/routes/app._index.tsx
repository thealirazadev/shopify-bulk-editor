import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useNavigate, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  Box,
  Card,
  ChoiceList,
  EmptyState,
  IndexFilters,
  IndexTable,
  Layout,
  Page,
  Text,
  TextField,
  useIndexResourceState,
  useSetIndexFiltersMode,
} from "@shopify/polaris";
import type { IndexFiltersProps } from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiError, newRequestId } from "~/lib/errors";
import { compileFilter, filterFromParams, isEmptyFilter } from "~/lib/filters";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

const PAGE_SIZE = 50;

const BROWSE_QUERY = `#graphql
  query BrowseProducts($first: Int, $after: String, $last: Int, $before: String, $query: String) {
    products(first: $first, after: $after, last: $last, before: $before, query: $query, sortKey: TITLE) {
      edges {
        node {
          id
          title
          status
          vendor
          tags
          variantsCount { count }
          priceRangeV2 {
            minVariantPrice { amount }
            maxVariantPrice { amount }
          }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
    collections(first: 100, sortKey: TITLE) {
      edges { node { id title } }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  status: string;
  vendor: string | null;
  tags: string[];
  variantsCount: { count: number } | null;
  priceRangeV2: {
    minVariantPrice: { amount: string };
    maxVariantPrice: { amount: string };
  } | null;
}

interface BrowseResponse {
  data?: {
    products: {
      edges: { node: ProductNode }[];
      pageInfo: {
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        startCursor: string | null;
        endCursor: string | null;
      };
    };
    collections: { edges: { node: { id: string; title: string } }[] };
  };
}

function priceRange(node: ProductNode): string {
  if (!node.priceRangeV2) return "—";
  const min = node.priceRangeV2.minVariantPrice.amount;
  const max = node.priceRangeV2.maxVariantPrice.amount;
  return min === max ? min : `${min} - ${max}`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const requestId = newRequestId();
  const url = new URL(request.url);
  const filter = filterFromParams(url.searchParams);
  const query = compileFilter(filter);
  const dir = url.searchParams.get("dir");
  const cursor = url.searchParams.get("cursor");

  const variables =
    dir === "prev" && cursor
      ? { last: PAGE_SIZE, before: cursor, query: query || undefined }
      : { first: PAGE_SIZE, after: cursor || undefined, query: query || undefined };

  try {
    const response = await admin.graphql(BROWSE_QUERY, { variables });
    const body = (await response.json()) as BrowseResponse;

    if (!body.data) {
      throw new Error("Admin GraphQL returned no product data");
    }

    return json({
      products: body.data.products.edges.map((edge) => ({
        id: edge.node.id,
        title: edge.node.title,
        status: edge.node.status,
        vendor: edge.node.vendor ?? "",
        tags: edge.node.tags,
        totalVariants: edge.node.variantsCount?.count ?? 0,
        priceRange: priceRange(edge.node),
      })),
      pageInfo: body.data.products.pageInfo,
      collections: body.data.collections.edges.map((edge) => edge.node),
      filter,
      error: null as null | { code: string; message: string; requestId: string },
    });
  } catch (error) {
    logger.error("failed to load products", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });

    return json({
      products: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      collections: [],
      filter,
      error: apiError("UPSTREAM_ERROR", "Could not load products. Try again.", requestId).error,
    });
  }
}

function statusTone(status: string): "success" | "info" | undefined {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT") return "info";
  return undefined;
}

export default function ProductsIndex() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { mode, setMode } = useSetIndexFiltersMode();

  const [status, setStatus] = useState<string[]>(data.filter.status ? [data.filter.status] : []);
  const [collection, setCollection] = useState<string[]>(
    data.filter.collectionId ? [data.filter.collectionId] : [],
  );
  const [vendor, setVendor] = useState(data.filter.vendor ?? "");
  const [tag, setTag] = useState(data.filter.tag ?? "");
  const [title, setTitle] = useState(data.filter.title ?? "");

  // Push the current filter state into the URL (which reloads the loader),
  // debounced so typing does not fire a request per keystroke. Skips the first
  // render so opening the page does not immediately re-navigate.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }

    const handle = setTimeout(() => {
      const next = new URLSearchParams();
      if (status[0]) next.set("status", status[0]);
      if (collection[0]) next.set("collectionId", collection[0]);
      if (vendor.trim()) next.set("vendor", vendor.trim());
      if (tag.trim()) next.set("tag", tag.trim());
      if (title.trim()) next.set("title", title.trim());
      setSearchParams(next, { replace: true });
    }, 400);

    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, collection, vendor, tag, title]);

  const handleClearAll = useCallback(() => {
    setStatus([]);
    setCollection([]);
    setVendor("");
    setTag("");
    setTitle("");
  }, []);

  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(
    data.products.map((product) => ({ id: product.id })),
  );

  const filters: IndexFiltersProps["filters"] = [
    {
      key: "status",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          choices={[
            { label: "Active", value: "ACTIVE" },
            { label: "Draft", value: "DRAFT" },
            { label: "Archived", value: "ARCHIVED" },
          ]}
          selected={status}
          onChange={setStatus}
        />
      ),
      shortcut: true,
    },
    {
      key: "collection",
      label: "Collection",
      filter: (
        <ChoiceList
          title="Collection"
          titleHidden
          choices={data.collections.map((entry) => ({ label: entry.title, value: entry.id }))}
          selected={collection}
          onChange={setCollection}
        />
      ),
    },
    {
      key: "vendor",
      label: "Vendor",
      filter: (
        <TextField
          label="Vendor"
          labelHidden
          autoComplete="off"
          value={vendor}
          onChange={setVendor}
        />
      ),
    },
    {
      key: "tag",
      label: "Tag",
      filter: (
        <TextField label="Tag" labelHidden autoComplete="off" value={tag} onChange={setTag} />
      ),
    },
  ];

  const appliedFilters: NonNullable<IndexFiltersProps["appliedFilters"]> = [];
  if (status[0]) {
    appliedFilters.push({
      key: "status",
      label: `Status ${status[0]}`,
      onRemove: () => setStatus([]),
    });
  }
  if (collection[0]) {
    const found = data.collections.find((entry) => entry.id === collection[0]);
    appliedFilters.push({
      key: "collection",
      label: `Collection ${found?.title ?? ""}`,
      onRemove: () => setCollection([]),
    });
  }
  if (vendor.trim()) {
    appliedFilters.push({
      key: "vendor",
      label: `Vendor ${vendor}`,
      onRemove: () => setVendor(""),
    });
  }
  if (tag.trim()) {
    appliedFilters.push({ key: "tag", label: `Tag ${tag}`, onRemove: () => setTag("") });
  }

  const goToPage = useCallback(
    (direction: "next" | "prev") => {
      const next = new URLSearchParams(searchParams);
      next.set("dir", direction);
      const cursorValue =
        direction === "next" ? data.pageInfo.endCursor : data.pageInfo.startCursor;
      if (cursorValue) next.set("cursor", cursorValue);
      navigate(`/app?${next.toString()}`);
    },
    [searchParams, data.pageInfo, navigate],
  );

  const selectedCount = allResourcesSelected ? data.products.length : selectedResources.length;

  return (
    <Page title="Products">
      <Layout>
        <Layout.Section>
          {data.error ? (
            <Banner tone="critical" title="Could not load products">
              <p>{data.error.message}</p>
            </Banner>
          ) : null}

          <Card padding="0">
            <IndexFilters
              queryValue={title}
              queryPlaceholder="Search by product title"
              onQueryChange={setTitle}
              onQueryClear={() => setTitle("")}
              tabs={[{ id: "all", content: "All products" }]}
              selected={0}
              onSelect={() => {}}
              canCreateNewView={false}
              filters={filters}
              appliedFilters={appliedFilters}
              onClearAll={handleClearAll}
              mode={mode}
              setMode={setMode}
            />

            {data.products.length === 0 ? (
              <EmptyState
                heading="No products match these filters"
                image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
              >
                <p>
                  {isEmptyFilter(data.filter)
                    ? "This store has no products yet."
                    : "Adjust or clear the filters to see products."}
                </p>
              </EmptyState>
            ) : (
              <>
                <Box padding="300">
                  <Text as="span" tone="subdued">
                    {selectedCount > 0
                      ? `${selectedCount} selected`
                      : `Showing ${data.products.length} products`}
                  </Text>
                </Box>
                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={data.products.length}
                  selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                  onSelectionChange={handleSelectionChange}
                  headings={[
                    { title: "Product" },
                    { title: "Status" },
                    { title: "Vendor" },
                    { title: "Tags" },
                    { title: "Variants" },
                    { title: "Price range" },
                  ]}
                  pagination={{
                    hasNext: data.pageInfo.hasNextPage,
                    hasPrevious: data.pageInfo.hasPreviousPage,
                    onNext: () => goToPage("next"),
                    onPrevious: () => goToPage("prev"),
                  }}
                >
                  {data.products.map((product, index) => (
                    <IndexTable.Row
                      id={product.id}
                      key={product.id}
                      selected={selectedResources.includes(product.id)}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="semibold">
                          {product.title}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={statusTone(product.status)}>{product.status}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{product.vendor}</IndexTable.Cell>
                      <IndexTable.Cell>{product.tags.slice(0, 3).join(", ")}</IndexTable.Cell>
                      <IndexTable.Cell>{String(product.totalVariants)}</IndexTable.Cell>
                      <IndexTable.Cell>{product.priceRange}</IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
