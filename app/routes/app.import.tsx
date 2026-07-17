import { createHash } from "node:crypto";

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  json,
  redirect,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  DropZone,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useState } from "react";

import db from "~/db.server";
import type { Snapshot } from "~/lib/edit-set";
import { apiError, newRequestId } from "~/lib/errors";
import { parseImportCsv } from "~/lib/csv.server";
import type { ImportProduct } from "~/lib/csv.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

const MAX_BYTES = 5 * 1024 * 1024;

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({});
}

function buildAfter(product: ImportProduct): Snapshot {
  const after: Snapshot = {};
  if (product.variants.length > 0) {
    after.variants = product.variants.map((variant) => ({
      id: variant.variantId,
      price: variant.price,
    }));
  }
  if (product.status !== null) after.status = product.status;
  if (product.tags !== null) after.tags = { list: product.tags, delta: [] };
  return after;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const requestId = newRequestId();

  let content: string;
  let fileName: string;
  try {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: MAX_BYTES });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return json(
        { error: apiError("INVALID_INPUT", "Choose a CSV file to upload.", requestId).error },
        { status: 400 },
      );
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      return json(
        { error: apiError("INVALID_INPUT", "The file must be a .csv file.", requestId).error },
        { status: 400 },
      );
    }
    fileName = file.name;
    content = await file.text();
  } catch (error) {
    logger.warn("csv upload rejected", {
      shop: session.shop,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      { error: apiError("LIMIT_EXCEEDED", "The file is larger than 5 MB.", requestId).error },
      { status: 400 },
    );
  }

  const parsed = parseImportCsv(content);
  if (!parsed.ok) {
    return json(
      {
        error: apiError("INVALID_INPUT", parsed.error ?? "The file is not valid.", requestId).error,
      },
      { status: 400 },
    );
  }

  try {
    const fileHash = createHash("sha256").update(content).digest("hex");
    const jobRow = await db.job.create({
      data: { shop: session.shop, type: "csv_import", status: "staging", fileName, fileHash },
    });

    const validItems = parsed.products.map((product) => ({
      jobId: jobRow.id,
      productGid: product.productGid,
      productTitle: product.productTitle,
      csvRow: product.firstRow,
      status: "pending",
      afterJson: JSON.stringify(buildAfter(product)),
    }));
    const invalidItems = parsed.invalidRows.map((row) => ({
      jobId: jobRow.id,
      productGid: "",
      productTitle: row.productTitle,
      csvRow: row.csvRow,
      status: "invalid",
      message: row.message,
    }));

    await db.jobItem.createMany({ data: [...validItems, ...invalidItems] });
    await db.job.update({
      where: { id: jobRow.id },
      data: { totalItems: validItems.length + invalidItems.length },
    });

    return redirect(`/app/edits/${jobRow.id}`);
  } catch (error) {
    logger.error("csv import job creation failed", {
      shop: session.shop,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      { error: apiError("INTERNAL", "Could not start the import. Try again.", requestId).error },
      { status: 500 },
    );
  }
}

const COLUMN_REFERENCE: string[][] = [
  ["product_id", "Required", "The product GID, as exported."],
  ["variant_id", "Required", "The variant GID, as exported."],
  ["price", "Editable", "Per variant. A number with no currency symbol."],
  ["status", "Editable", "Product-level. ACTIVE, DRAFT, or ARCHIVED."],
  ["tags", "Editable", "Product-level. Full comma-separated replacement list."],
];

export default function ImportCsv() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [file, setFile] = useState<File | null>(null);
  const busy = navigation.state !== "idle";

  const upload = () => {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <Page title="Import CSV">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error ? (
              <Banner tone="critical" title="Import could not start">
                <p>{actionData.error.message}</p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="p">
                  Upload an edited product export. Every row is validated and previewed before
                  anything is written.
                </Text>
                <DropZone
                  accept=".csv"
                  type="file"
                  allowMultiple={false}
                  onDrop={(_files, accepted) => setFile(accepted[0] ?? null)}
                >
                  {file ? (
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="span">{file.name}</Text>
                    </BlockStack>
                  ) : (
                    <DropZone.FileUpload actionTitle="Add CSV file" />
                  )}
                </DropZone>
                <Button variant="primary" onClick={upload} loading={busy} disabled={!file}>
                  Upload and preview
                </Button>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Column reference
                </Text>
                <DataTable
                  columnContentTypes={["text", "text", "text"]}
                  headings={["Column", "Role", "Notes"]}
                  rows={COLUMN_REFERENCE}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
