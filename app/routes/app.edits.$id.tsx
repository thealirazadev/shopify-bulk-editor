import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
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
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  ProgressBar,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";

import db from "~/db.server";
import { validateEditSet } from "~/lib/edit-set";
import type { Snapshot } from "~/lib/edit-set";
import { apiError, newRequestId } from "~/lib/errors";
import type { Selection } from "~/lib/jobs";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

function selectionSummary(job: { selectionJson: string | null }): string {
  const selection = job.selectionJson ? (JSON.parse(job.selectionJson) as Selection) : null;
  if (!selection) return "No products selected";
  if (selection.mode === "explicit") {
    return `${selection.productIds.length} selected products`;
  }
  return "All products matching the current filter";
}

interface ChangeRow {
  label: string;
  from: string;
  to: string;
}

interface PreviewItem {
  id: string;
  productTitle: string;
  status: string;
  message: string | null;
  csvRow: number | null;
  changes: ChangeRow[];
}

function priceText(variants: { price: string }[]): string {
  if (variants.length === 0) return "—";
  const amounts = variants.map((variant) => Number(variant.price));
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return min === max ? min.toFixed(2) : `${min.toFixed(2)}–${max.toFixed(2)}`;
}

function changeRows(before: Snapshot, after: Snapshot): ChangeRow[] {
  const rows: ChangeRow[] = [];
  if (after.variants && before.variants) {
    rows.push({ label: "Price", from: priceText(before.variants), to: priceText(after.variants) });
  }
  if (after.status !== undefined) {
    rows.push({ label: "Status", from: before.status ?? "", to: after.status });
  }
  if (after.tags && before.tags) {
    rows.push({
      label: "Tags",
      from: before.tags.list.join(", ") || "(none)",
      to: after.tags.list.join(", ") || "(none)",
    });
  }
  if (after.metafield) {
    rows.push({
      label: `Metafield ${after.metafield.key}`,
      from: before.metafield?.value ?? "(none)",
      to: after.metafield.value ?? "(none)",
    });
  }
  return rows;
}

function toPreviewItem(row: {
  id: string;
  productTitle: string;
  status: string;
  message: string | null;
  csvRow: number | null;
  beforeJson: string | null;
  afterJson: string | null;
}): PreviewItem {
  const before = row.beforeJson ? (JSON.parse(row.beforeJson) as Snapshot) : {};
  const after = row.afterJson ? (JSON.parse(row.afterJson) as Snapshot) : {};
  return {
    id: row.id,
    productTitle: row.productTitle,
    status: row.status,
    message: row.message,
    csvRow: row.csvRow,
    changes: changeRows(before, after),
  };
}

const PAGE_SIZE = 50;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const job = await db.job.findFirst({ where: { id: params.id, shop: session.shop } });

  if (!job) {
    throw new Response("Not found", { status: 404 });
  }

  // Once applied or beyond, the job lives on the job detail screen.
  if (!["draft", "staging", "staged"].includes(job.status)) {
    return redirect(`/app/jobs/${job.id}`);
  }

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
  const itemStatus = url.searchParams.get("itemStatus");
  const jobSummary = {
    id: job.id,
    status: job.status,
    totalItems: job.totalItems,
    processedCount: job.processedCount,
    errorMessage: job.errorMessage,
  };

  if (job.status !== "staged") {
    return json({
      job: jobSummary,
      selectionText: selectionSummary(job),
      items: [] as PreviewItem[],
      counts: {} as Record<string, number>,
      page,
      hasNext: false,
      itemStatus,
      duplicateOfJobId: null as string | null,
    });
  }

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

  // Warn when this import's file was already applied for this shop.
  let duplicateOfJobId: string | null = null;
  if (job.type === "csv_import" && job.fileHash) {
    const duplicate = await db.job.findFirst({
      where: {
        shop: session.shop,
        type: "csv_import",
        fileHash: job.fileHash,
        status: { in: ["completed", "completed_with_errors"] },
        id: { not: job.id },
      },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    });
    duplicateOfJobId = duplicate?.id ?? null;
  }

  return json({
    job: jobSummary,
    selectionText: selectionSummary(job),
    items: rows.slice(0, PAGE_SIZE).map(toPreviewItem),
    counts,
    page,
    hasNext: rows.length > PAGE_SIZE,
    itemStatus,
    duplicateOfJobId,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const requestId = newRequestId();
  const job = await db.job.findFirst({ where: { id: params.id, shop: session.shop } });

  if (!job) {
    return json(
      { ok: false as const, error: apiError("NOT_FOUND", "Job not found.", requestId).error },
      { status: 404 },
    );
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "stage") {
      const parsed = validateEditSet(JSON.parse(String(formData.get("editSetJson") ?? "null")));
      if (!parsed.valid) {
        return json({ ok: false as const, errors: parsed.errors }, { status: 400 });
      }

      const updated = await db.job.updateMany({
        where: { id: job.id, shop: session.shop, status: { in: ["draft", "staged"] } },
        data: {
          editSetJson: JSON.stringify(parsed.editSet),
          status: "staging",
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count === 0) {
        return json(
          {
            ok: false as const,
            error: apiError("CONFLICT", "This job cannot be staged now.", requestId).error,
          },
          { status: 409 },
        );
      }
      return json({ ok: true as const });
    }

    if (intent === "apply") {
      const updated = await db.job.updateMany({
        where: { id: job.id, shop: session.shop, status: "staged" },
        data: { status: "queued" },
      });
      if (updated.count === 0) {
        return json(
          {
            ok: false as const,
            error: apiError("CONFLICT", "This job was already applied or is not ready.", requestId)
              .error,
          },
          { status: 409 },
        );
      }
      return redirect(`/app/jobs/${job.id}`);
    }

    if (intent === "discard") {
      await db.job.updateMany({
        where: { id: job.id, shop: session.shop, status: { in: ["draft", "staged"] } },
        data: { status: "discarded", finishedAt: new Date() },
      });
      return redirect("/app");
    }

    return json(
      { ok: false as const, error: apiError("INVALID_INPUT", "Unknown action.", requestId).error },
      { status: 400 },
    );
  } catch (error) {
    logger.error("edit job action failed", {
      shop: session.shop,
      jobId: job.id,
      requestId,
      intent,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      {
        ok: false as const,
        error: apiError("INTERNAL", "Something went wrong. Try again.", requestId).error,
      },
      { status: 500 },
    );
  }
}

type Field = "price" | "status" | "tags" | "metafield";

interface OpDraft {
  field: Field;
  op: string;
  value: string;
  namespace: string;
  key: string;
  type: string;
}

function defaultOp(field: Field): OpDraft {
  const base = { value: "", namespace: "custom", key: "", type: "single_line_text_field" };
  if (field === "price") return { field, op: "adjust_percent", ...base };
  if (field === "status") return { field, op: "set", ...base, value: "DRAFT" };
  if (field === "tags") return { field, op: "add", ...base };
  return { field, op: "set", ...base };
}

function serialize(op: OpDraft) {
  if (op.field === "metafield") {
    return {
      field: "metafield",
      op: "set",
      namespace: op.namespace,
      key: op.key,
      type: op.type,
      value: op.value,
    };
  }
  return { field: op.field, op: op.op, value: op.value };
}

const ALL_FIELDS: Field[] = ["price", "status", "tags", "metafield"];

export default function EditJob() {
  const data = useLoaderData<typeof loader>();

  if (data.job.status === "staging") {
    return <StagingProgress total={data.job.totalItems} processed={data.job.processedCount} />;
  }
  if (data.job.status === "staged") {
    return <Preview data={data} />;
  }
  return <Builder selectionText={data.selectionText} />;
}

function StagingProgress({ total, processed }: { total: number; processed: number }) {
  // The loader is revalidated every 2s by the polling effect on this page.
  usePoll();
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <Page title="Preparing preview">
      <Card>
        <BlockStack gap="300">
          <Text as="p">
            Preparing preview — {total > 0 ? `${processed} of ${total}` : "working"}
          </Text>
          <ProgressBar progress={pct} />
        </BlockStack>
      </Card>
    </Page>
  );
}

function outcomeBadge(status: string) {
  if (status === "pending") return <Badge tone="attention">Will change</Badge>;
  if (status === "invalid") return <Badge tone="critical">Invalid</Badge>;
  if (status === "skipped_unchanged") return <Badge>Unchanged</Badge>;
  return <Badge>{status}</Badge>;
}

function Preview({ data }: { data: SerializeFrom<typeof loader> }) {
  const submit = useSubmit();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busy = navigation.state !== "idle";

  const willChange = data.counts.pending ?? 0;
  const unchanged = data.counts.skipped_unchanged ?? 0;
  const invalid = data.counts.invalid ?? 0;

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key === "itemStatus") next.delete("page");
      navigate(`?${next.toString()}`);
    },
    [searchParams, navigate],
  );

  return (
    <Page
      title="Preview changes"
      subtitle={`${data.job.totalItems} products staged`}
      primaryAction={{
        content: `Apply to ${willChange} products`,
        disabled: willChange === 0 || busy,
        onAction: () => setConfirmOpen(true),
      }}
      secondaryActions={[
        { content: "Discard", onAction: () => submit({ intent: "discard" }, { method: "post" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {data.duplicateOfJobId ? (
              <Banner tone="warning" title="This file was already imported">
                <p>
                  A file with the same contents was applied before. Re-applying will not compound
                  changes; rows that already match are skipped.
                </p>
              </Banner>
            ) : null}

            <Banner tone="info">
              {willChange} products will change, {unchanged} skipped (already match), {invalid}{" "}
              invalid.
            </Banner>

            <Card padding="0">
              <Box padding="300">
                <ChoiceList
                  title="Filter by outcome"
                  titleHidden
                  choices={[
                    { label: "All", value: "all" },
                    { label: "Will change", value: "pending" },
                    { label: "Unchanged", value: "skipped_unchanged" },
                    { label: "Invalid", value: "invalid" },
                  ]}
                  selected={[data.itemStatus ?? "all"]}
                  onChange={(value) => setParam("itemStatus", value[0] === "all" ? null : value[0])}
                />
              </Box>
              <IndexTable
                selectable={false}
                resourceName={{ singular: "product", plural: "products" }}
                itemCount={data.items.length}
                headings={[{ title: "Product" }, { title: "Changes" }, { title: "Outcome" }]}
              >
                {data.items.map((item, index) => (
                  <IndexTable.Row id={item.id} key={item.id} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">
                        {item.productTitle}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        {item.changes.map((change) => (
                          <Text as="span" key={change.label}>
                            {change.label}:{" "}
                            <Text as="span" tone="subdued">
                              {change.from}
                            </Text>
                            <Text as="span" visuallyHidden>
                              {" "}
                              was, becomes{" "}
                            </Text>{" "}
                            → {change.to}
                          </Text>
                        ))}
                        {item.message ? (
                          <Text as="span" tone="critical">
                            {item.message}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{outcomeBadge(item.status)}</IndexTable.Cell>
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
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Apply changes"
        primaryAction={{
          content: `Apply to ${willChange} products`,
          loading: busy,
          onAction: () => {
            setConfirmOpen(false);
            submit({ intent: "apply" }, { method: "post" });
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirmOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            This will update {willChange} products in your store as a background job. You can undo
            the job afterward.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function Builder({ selectionText }: { selectionText: string }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const [ops, setOps] = useState<OpDraft[]>([defaultOp("price")]);
  const [errors, setErrors] = useState<string[]>([]);
  const busy = navigation.state !== "idle";

  const usedFields = useMemo(() => new Set(ops.map((op) => op.field)), [ops]);
  const addOp = useCallback(() => {
    const nextField = ALL_FIELDS.find((field) => !usedFields.has(field));
    if (nextField) setOps((prev) => [...prev, defaultOp(nextField)]);
  }, [usedFields]);

  const updateOp = useCallback((index: number, patch: Partial<OpDraft>) => {
    setOps((prev) => prev.map((op, current) => (current === index ? { ...op, ...patch } : op)));
  }, []);

  const removeOp = useCallback((index: number) => {
    setOps((prev) => prev.filter((_, current) => current !== index));
  }, []);

  const preview = useCallback(() => {
    const editSet = { operations: ops.map(serialize) };
    const validation = validateEditSet(editSet);
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    setErrors([]);
    submit({ intent: "stage", editSetJson: JSON.stringify(editSet) }, { method: "post" });
  }, [ops, submit]);

  return (
    <Page
      title="New bulk edit"
      subtitle={selectionText}
      primaryAction={{
        content: "Preview changes",
        onAction: preview,
        loading: busy,
        disabled: ops.length === 0,
      }}
      secondaryActions={[
        { content: "Add operation", onAction: addOp, disabled: ops.length >= ALL_FIELDS.length },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {errors.length > 0 ? (
              <Banner tone="critical" title="Fix these before previewing">
                <BlockStack gap="100">
                  {errors.map((message) => (
                    <Text as="p" key={message}>
                      {message}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            ) : null}

            {ops.map((op, index) => (
              <OperationCard
                key={op.field}
                op={op}
                usedFields={usedFields}
                onChange={(patch) => updateOp(index, patch)}
                onRemove={() => removeOp(index)}
              />
            ))}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function OperationCard({
  op,
  usedFields,
  onChange,
  onRemove,
}: {
  op: OpDraft;
  usedFields: Set<Field>;
  onChange: (patch: Partial<OpDraft>) => void;
  onRemove: () => void;
}) {
  const fieldChoices = ALL_FIELDS.map((field) => ({
    label: field[0].toUpperCase() + field.slice(1),
    value: field,
    disabled: field !== op.field && usedFields.has(field),
  }));

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" align="space-between">
          <Text as="h2" variant="headingSm">
            {op.field[0].toUpperCase() + op.field.slice(1)}
          </Text>
          <Button tone="critical" variant="plain" onClick={onRemove}>
            Remove
          </Button>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Select
            label="Field"
            options={fieldChoices}
            value={op.field}
            onChange={(value) => onChange({ ...defaultOp(value as Field) })}
          />

          {op.field === "price" ? (
            <>
              <Select
                label="Operation"
                options={[
                  { label: "Set to", value: "set" },
                  { label: "Adjust by percent", value: "adjust_percent" },
                  { label: "Adjust by amount", value: "adjust_amount" },
                ]}
                value={op.op}
                onChange={(value) => onChange({ op: value })}
              />
              <TextField
                label="Value"
                autoComplete="off"
                value={op.value}
                onChange={(value) => onChange({ value })}
                suffix={op.op === "adjust_percent" ? "%" : undefined}
              />
            </>
          ) : null}

          {op.field === "status" ? (
            <Select
              label="Set status to"
              options={[
                { label: "Active", value: "ACTIVE" },
                { label: "Draft", value: "DRAFT" },
                { label: "Archived", value: "ARCHIVED" },
              ]}
              value={op.value}
              onChange={(value) => onChange({ value })}
            />
          ) : null}

          {op.field === "tags" ? (
            <>
              <Select
                label="Operation"
                options={[
                  { label: "Add", value: "add" },
                  { label: "Remove", value: "remove" },
                ]}
                value={op.op}
                onChange={(value) => onChange({ op: value })}
              />
              <TextField
                label="Tag"
                autoComplete="off"
                value={op.value}
                onChange={(value) => onChange({ value })}
              />
            </>
          ) : null}

          {op.field === "metafield" ? (
            <>
              <TextField
                label="Namespace"
                autoComplete="off"
                value={op.namespace}
                onChange={(value) => onChange({ namespace: value })}
              />
              <TextField
                label="Key"
                autoComplete="off"
                value={op.key}
                onChange={(value) => onChange({ key: value })}
              />
              <Select
                label="Type"
                options={[
                  { label: "Text", value: "single_line_text_field" },
                  { label: "Integer", value: "number_integer" },
                  { label: "Decimal", value: "number_decimal" },
                  { label: "Boolean", value: "boolean" },
                ]}
                value={op.type}
                onChange={(value) => onChange({ type: value })}
              />
              <TextField
                label="Value"
                autoComplete="off"
                value={op.value}
                onChange={(value) => onChange({ value })}
              />
            </>
          ) : null}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// Revalidate the loader every 2 seconds while a job is staging; the interval is
// cleared when the component unmounts (status leaves "staging").
function usePoll() {
  const revalidator = useRevalidator();
  useEffect(() => {
    const handle = setInterval(() => revalidator.revalidate(), 2000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
