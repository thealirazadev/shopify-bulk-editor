import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Box,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Page,
  Pagination,
  Text,
} from "@shopify/polaris";
import type { BadgeProps } from "@shopify/polaris";

import db from "~/db.server";
import { authenticate } from "~/shopify.server";

const PAGE_SIZE = 25;

const TYPE_LABEL: Record<string, string> = {
  edit: "Bulk edit",
  csv_import: "CSV import",
  export: "Export",
  undo: "Undo",
};

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

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));

  const rows = await db.job.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });

  return json({
    jobs: rows.slice(0, PAGE_SIZE).map((jobRow) => ({
      id: jobRow.id,
      type: jobRow.type,
      status: jobRow.status,
      successCount: jobRow.successCount,
      failedCount: jobRow.failedCount,
      totalItems: jobRow.totalItems,
      createdAt: jobRow.createdAt.toISOString(),
    })),
    page,
    hasNext: rows.length > PAGE_SIZE,
  });
}

export default function JobsIndex() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const goToPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    navigate(`?${next.toString()}`);
  };

  if (data.jobs.length === 0 && data.page === 1) {
    return (
      <Page title="Jobs">
        <Card>
          <EmptyState
            heading="No jobs yet"
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>Bulk edits, imports, and exports you run will appear here.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Jobs">
      <Card padding="0">
        <IndexTable
          selectable={false}
          resourceName={{ singular: "job", plural: "jobs" }}
          itemCount={data.jobs.length}
          headings={[
            { title: "Date" },
            { title: "Type" },
            { title: "Status" },
            { title: "Changed" },
            { title: "Failed" },
          ]}
        >
          {data.jobs.map((jobRow, index) => (
            <IndexTable.Row
              id={jobRow.id}
              key={jobRow.id}
              position={index}
              onClick={() => navigate(`/app/jobs/${jobRow.id}`)}
            >
              <IndexTable.Cell>{new Date(jobRow.createdAt).toLocaleString()}</IndexTable.Cell>
              <IndexTable.Cell>{TYPE_LABEL[jobRow.type] ?? jobRow.type}</IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={STATUS_TONE[jobRow.status]}>{jobRow.status}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span">{String(jobRow.successCount)}</Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span">{String(jobRow.failedCount)}</Text>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
        <Box padding="300">
          <InlineStack align="center">
            <Pagination
              hasPrevious={data.page > 1}
              onPrevious={() => goToPage(data.page - 1)}
              hasNext={data.hasNext}
              onNext={() => goToPage(data.page + 1)}
            />
          </InlineStack>
        </Box>
      </Card>
    </Page>
  );
}
