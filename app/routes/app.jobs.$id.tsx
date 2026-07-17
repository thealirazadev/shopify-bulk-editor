import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  ChoiceList,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  ProgressBar,
  Text,
  Tooltip,
} from "@shopify/polaris";
import type { BadgeProps } from "@shopify/polaris";
import { useEffect, useState } from "react";

import db from "~/db.server";
import { apiError, newRequestId } from "~/lib/errors";
import { computeInverseItems } from "~/lib/undo";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

const PAGE_SIZE = 50;
const ACTIVE_STATUSES = ["staging", "queued", "running"];
const UNDOABLE_TYPES = ["edit", "csv_import"];
const APPLIED_STATUSES = ["completed", "completed_with_errors"];

const TYPE_LABEL: Record<string, string> = {
  edit: "Bulk edit",
  csv_import: "CSV import",
  export: "Export",
  undo: "Undo",
};

// The shop's most recent applied edit/import job id, for undo eligibility.
async function latestUndoableJobId(shop: string): Promise<string | null> {
  const latest = await db.job.findFirst({
    where: { shop, type: { in: UNDOABLE_TYPES }, status: { in: APPLIED_STATUSES } },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  return latest?.id ?? null;
}

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

  const isUndoableType = UNDOABLE_TYPES.includes(job.type);
  const isApplied = APPLIED_STATUSES.includes(job.status);
  const isLatest = isApplied && (await latestUndoableJobId(session.shop)) === job.id;
  let canUndo = false;
  let undoReason: string | null = null;
  if (isUndoableType) {
    if (job.undoneByJobId) {
      undoReason = "This job was already undone.";
    } else if (isApplied && isLatest) {
      canUndo = true;
    } else if (isApplied) {
      undoReason = "Only the most recent applied job can be undone.";
    } else {
      undoReason = "Only a completed job can be undone.";
    }
  }

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
    isUndoableType,
    canUndo,
    undoReason,
    canCancel: ["queued", "running"].includes(job.status),
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

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const requestId = newRequestId();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const job = await db.job.findFirst({ where: { id: params.id, shop: session.shop } });

  if (!job) {
    return json(
      { error: apiError("NOT_FOUND", "Job not found.", requestId).error },
      { status: 404 },
    );
  }

  if (intent === "cancel") {
    const counts = {
      successCount: await db.jobItem.count({ where: { jobId: job.id, status: "applied" } }),
      failedCount: await db.jobItem.count({ where: { jobId: job.id, status: "failed" } }),
      skippedCount: await db.jobItem.count({
        where: {
          jobId: job.id,
          status: { in: ["skipped_stale", "skipped_unchanged", "invalid"] },
        },
      }),
    };
    await db.job.updateMany({
      where: { id: job.id, shop: session.shop, status: { in: ["queued", "running"] } },
      data: {
        status: "canceled",
        finishedAt: new Date(),
        processedCount: counts.successCount + counts.failedCount + counts.skippedCount,
        ...counts,
      },
    });
    return json({ ok: true });
  }

  if (intent !== "undo") {
    return json(
      { error: apiError("INVALID_INPUT", "Unknown action.", requestId).error },
      { status: 400 },
    );
  }

  if (!UNDOABLE_TYPES.includes(job.type) || !APPLIED_STATUSES.includes(job.status)) {
    return json(
      { error: apiError("CONFLICT", "This job cannot be undone.", requestId).error },
      { status: 409 },
    );
  }
  if (job.undoneByJobId) {
    return json(
      { error: apiError("CONFLICT", "This job was already undone.", requestId).error },
      { status: 409 },
    );
  }
  if ((await latestUndoableJobId(session.shop)) !== job.id) {
    return json(
      { error: apiError("CONFLICT", "A newer job has been applied.", requestId).error },
      { status: 409 },
    );
  }

  const appliedItems = await db.jobItem.findMany({
    where: { jobId: job.id, status: "applied" },
  });
  const undoItems = computeInverseItems(appliedItems);
  if (undoItems.length === 0) {
    return json(
      { error: apiError("CONFLICT", "There is nothing to undo.", requestId).error },
      { status: 409 },
    );
  }

  try {
    const undoJob = await db.job.create({
      data: {
        shop: session.shop,
        type: "undo",
        status: "staged",
        undoOfJobId: job.id,
        totalItems: undoItems.length,
      },
    });
    await db.jobItem.createMany({
      data: undoItems.map((undoItem) => ({
        jobId: undoJob.id,
        productGid: undoItem.productGid,
        productTitle: undoItem.productTitle,
        status: "pending",
        beforeJson: JSON.stringify(undoItem.before),
        afterJson: JSON.stringify(undoItem.after),
      })),
    });
    return redirect(`/app/edits/${undoJob.id}`);
  } catch (error) {
    // undoOfJobId is unique, so a concurrent undo attempt lands here.
    logger.warn("undo creation conflict", {
      shop: session.shop,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      { error: apiError("CONFLICT", "This job is already being undone.", requestId).error },
      { status: 409 },
    );
  }
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
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [cancelOpen, setCancelOpen] = useState(false);
  const active = ACTIVE_STATUSES.includes(data.job.status);
  const busy = navigation.state !== "idle";

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

                {data.isUndoableType || data.canCancel ? (
                  <InlineStack gap="300">
                    {data.canCancel ? (
                      <Button tone="critical" onClick={() => setCancelOpen(true)}>
                        Cancel
                      </Button>
                    ) : null}
                    {data.isUndoableType && data.canUndo ? (
                      <Button
                        loading={busy}
                        onClick={() => submit({ intent: "undo" }, { method: "post" })}
                      >
                        Undo this job
                      </Button>
                    ) : null}
                    {data.isUndoableType && !data.canUndo ? (
                      <Tooltip content={data.undoReason ?? "This job cannot be undone."}>
                        <Button disabled>Undo this job</Button>
                      </Tooltip>
                    ) : null}
                  </InlineStack>
                ) : null}
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

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this job?"
        primaryAction={{
          content: "Cancel job",
          destructive: true,
          loading: busy,
          onAction: () => {
            setCancelOpen(false);
            submit({ intent: "cancel" }, { method: "post" });
          },
        }}
        secondaryActions={[{ content: "Keep running", onAction: () => setCancelOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            The job stops after the current product. Products already updated stay updated and
            remain undoable.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
