import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigation, useRevalidator, useSubmit } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useEffect, useMemo, useState } from "react";

import db from "~/db.server";
import { validateEditSet } from "~/lib/edit-set";
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

  return json({
    job: {
      id: job.id,
      status: job.status,
      totalItems: job.totalItems,
      processedCount: job.processedCount,
      errorMessage: job.errorMessage,
    },
    selectionText: selectionSummary(job),
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
    return <StagedSummary total={data.job.totalItems} jobId={data.job.id} />;
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

function StagedSummary({ total, jobId }: { total: number; jobId: string }) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <Page title="Preview changes" subtitle={`${total} products staged`}>
      <Card>
        <BlockStack gap="300">
          <Text as="p">The preview is ready. Review the changes, then apply them.</Text>
          <InlineStack gap="300">
            <Button
              variant="primary"
              loading={busy}
              onClick={() => submit({ intent: "apply" }, { method: "post" })}
            >
              Apply
            </Button>
            <Button
              tone="critical"
              onClick={() => submit({ intent: "discard" }, { method: "post" })}
            >
              Discard
            </Button>
          </InlineStack>
          <Text as="span" tone="subdued">
            Job {jobId}
          </Text>
        </BlockStack>
      </Card>
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
