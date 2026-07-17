import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useRevalidator, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  ChoiceList,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Pagination,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import type { BadgeProps } from "@shopify/polaris";
import { useEffect } from "react";

import db from "~/db.server";
import { authenticate } from "~/shopify.server";

const PAGE_SIZE = 50;
const ACTIVE_STATUSES = ["staging", "queued", "running"];

const TYPE_LABEL: Record<string, string> = {
  edit: "Bulk edit",
  csv_import: "CSV import",
  export: "Export",
  undo: "Undo",
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const job = await db.job.findFirst({ where: { id: params.id, shop: session.shop } });

  if (!job) {
    throw new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const itemStatus = url.searchParams.get("itemStatus");
  const where = { jobId: job.id, ...(itemStatus ? { status: itemStatus } : {}) };

  const [rows, grouped] = await Promise.all([
    db.jobItem.findMany({
      where,
      orderBy: { id: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    }),
    db.jobItem.groupBy({ by: ["status"], where: { jobId: job.id }, _count: { _all: true } }),
  ]);

  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.status] = row._count._all;

  return json({
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      totalItems: job.totalItems,
      processedCount: job.processedCount,
      successCount: job.successCount,
      failedCount: job.failedCount,
      skippedCount: job.skippedCount,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
    },
    downloadReady: job.type === "export" && Boolean(job.resultPath),
    items: rows.slice(0, PAGE_SIZE).map((row) => ({
      id: row.id,
      productTitle: row.productTitle,
      status: row.status,
      message: row.message,
      csvRow: row.csvRow,
    })),
    counts,
    page,
    hasNext: rows.length > PAGE_SIZE,
    itemStatus,
  });
}

const STATUS_TONE: Record<string, BadgeProps["tone"]> = {
  draft: "new",
  staging: "attention",
  staged: "attention",
  queued: "attention",
  running: "info",
  completed: "success",
  completed_with_errors: "warning",
  failed: "critical",
  canceled: "new",
  discarded: "new",
};

function itemBadge(status: string) {
  if (status === "applied") return <Badge tone="success">Applied</Badge>;
  if (status === "failed") return <Badge tone="critical">Failed</Badge>;
  if (status === "skipped_stale") return <Badge tone="warning">Skipped (changed)</Badge>;
  if (status === "skipped_unchanged") return <Badge>Unchanged</Badge>;
  if (status === "invalid") return <Badge tone="critical">Invalid</Badge>;
  return <Badge tone="info">Pending</Badge>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="headingLg">
        {value}
      </Text>
      <Text as="span" tone="subdued">
        {label}
      </Text>
    </BlockStack>
  );
}

export default function JobDetail() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const active = ACTIVE_STATUSES.includes(data.job.status);

  useEffect(() => {
    if (!active) return undefined;
    const handle = setInterval(() => revalidator.revalidate(), 2000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "itemStatus") next.delete("page");
    navigate(`?${next.toString()}`);
  };

  const pct =
    data.job.totalItems > 0 ? Math.round((data.job.processedCount / data.job.totalItems) * 100) : 0;
  const title = `${TYPE_LABEL[data.job.type] ?? data.job.type} · ${new Date(
    data.job.createdAt,
  ).toLocaleString()}`;

  return (
    <Page
      title={title}
      titleMetadata={<Badge tone={STATUS_TONE[data.job.status]}>{data.job.status}</Badge>}
      primaryAction={
        data.downloadReady
          ? { content: "Download CSV", url: `/app/jobs/${data.job.id}/download`, external: true }
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {data.job.errorMessage ? (
              <Banner tone="critical" title="Job error">
                <p>{data.job.errorMessage}</p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                {active ? (
                  <>
                    <Text as="p">
                      Processing {data.job.processedCount} of {data.job.totalItems}
                    </Text>
                    <ProgressBar progress={pct} />
                  </>
                ) : null}
                <InlineGrid columns={{ xs: 2, sm: 4 }} gap="400">
                  <Stat label="Total" value={data.job.totalItems} />
                  <Stat label="Applied" value={data.job.successCount} />
                  <Stat label="Failed" value={data.job.failedCount} />
                  <Stat label="Skipped" value={data.job.skippedCount} />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card padding="0">
              <Box padding="300">
                <ChoiceList
                  title="Filter by outcome"
                  titleHidden
                  choices={[
                    { label: "All", value: "all" },
                    { label: "Applied", value: "applied" },
                    { label: "Failed", value: "failed" },
                    { label: "Skipped (changed)", value: "skipped_stale" },
                    { label: "Unchanged", value: "skipped_unchanged" },
                    { label: "Invalid", value: "invalid" },
                  ]}
                  selected={[data.itemStatus ?? "all"]}
                  onChange={(value) => setParam("itemStatus", value[0] === "all" ? null : value[0])}
                />
              </Box>
              <IndexTable
                selectable={false}
                resourceName={{ singular: "item", plural: "items" }}
                itemCount={data.items.length}
                headings={[{ title: "Product" }, { title: "Outcome" }, { title: "Detail" }]}
                emptyState={
                  <Box padding="400">
                    <Text as="p" alignment="center" tone="subdued">
                      No items for this outcome.
                    </Text>
                  </Box>
                }
              >
                {data.items.map((item, index) => (
                  <IndexTable.Row id={item.id} key={item.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">
                        {item.csvRow ? `Row ${item.csvRow}: ` : ""}
                        {item.productTitle}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{itemBadge(item.status)}</IndexTable.Cell>
                    <IndexTable.Cell>{item.message ?? ""}</IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
              <Box padding="300">
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={data.page > 1}
                    onPrevious={() => setParam("page", String(data.page - 1))}
                    hasNext={data.hasNext}
                    onNext={() => setParam("page", String(data.page + 1))}
                  />
                </InlineStack>
              </Box>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
