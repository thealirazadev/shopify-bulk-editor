import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useCallback, useEffect, useState } from "react";

import db from "~/db.server";
import { apiError, newRequestId } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { deleteEditSet, listEditSets, renameEditSet, summarizeEditSet } from "~/lib/saved-edit-set";
import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const listed = await listEditSets(db, session.shop);
  if (listed.skippedIds.length > 0) {
    logger.warn("skipping unreadable saved edit-sets", {
      shop: session.shop,
      ids: listed.skippedIds,
    });
  }

  return json({
    sets: listed.sets.map((set) => ({
      id: set.id,
      name: set.name,
      summary: summarizeEditSet(set.editSet),
      updatedAt: set.updatedAt,
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const requestId = newRequestId();
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");

  try {
    if (intent === "rename") {
      const result = await renameEditSet(db, session.shop, id, String(formData.get("name") ?? ""));
      if (!result.ok) {
        return json({ ok: false as const, errors: result.errors }, { status: 400 });
      }
      return json({ ok: true as const });
    }

    if (intent === "delete") {
      await deleteEditSet(db, session.shop, id);
      return json({ ok: true as const });
    }

    return json(
      { ok: false as const, error: apiError("INVALID_INPUT", "Unknown action.", requestId).error },
      { status: 400 },
    );
  } catch (error) {
    logger.error("saved edit-set action failed", {
      shop: session.shop,
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

type SavedSet = ReturnType<typeof useLoaderData<typeof loader>>["sets"][number];

export default function EditSetsIndex() {
  const data = useLoaderData<typeof loader>();
  const renameFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();

  const [renameTarget, setRenameTarget] = useState<SavedSet | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SavedSet | null>(null);

  const renameData = renameFetcher.data;
  const renameErrors =
    renameData && !renameData.ok && "errors" in renameData ? renameData.errors : [];

  // Close the rename modal once the rename resolves successfully.
  useEffect(() => {
    if (renameFetcher.state === "idle" && renameFetcher.data?.ok) {
      setRenameTarget(null);
    }
  }, [renameFetcher.state, renameFetcher.data]);

  // Close the delete confirmation once the delete resolves.
  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data?.ok) {
      setDeleteTarget(null);
    }
  }, [deleteFetcher.state, deleteFetcher.data]);

  const openRename = useCallback((set: SavedSet) => {
    setRenameValue(set.name);
    setRenameTarget(set);
  }, []);

  const confirmRename = useCallback(() => {
    if (!renameTarget) return;
    renameFetcher.submit(
      { intent: "rename", id: renameTarget.id, name: renameValue },
      { method: "post" },
    );
  }, [renameTarget, renameValue, renameFetcher]);

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteFetcher.submit({ intent: "delete", id: deleteTarget.id }, { method: "post" });
  }, [deleteTarget, deleteFetcher]);

  if (data.sets.length === 0) {
    return (
      <Page title="Saved edit-sets">
        <Card>
          <EmptyState
            heading="No saved edit-sets yet"
            image="https://cdn.shopify.com/s/files/1/0757/9955/files/empty-state.svg"
          >
            <p>
              Build an edit in a bulk edit and choose Save as edit-set to reuse the same operations
              later against a different selection.
            </p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Saved edit-sets"
      subtitle="Reusable field, operation, and value configurations. Loading one still previews before it applies."
    >
      <Card padding="0">
        <IndexTable
          selectable={false}
          resourceName={{ singular: "edit-set", plural: "edit-sets" }}
          itemCount={data.sets.length}
          headings={[
            { title: "Name" },
            { title: "Configuration" },
            { title: "Last updated" },
            { title: "Actions" },
          ]}
        >
          {data.sets.map((set, index) => (
            <IndexTable.Row id={set.id} key={set.id} position={index}>
              <IndexTable.Cell>
                <Text as="span" fontWeight="semibold">
                  {set.name}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" tone="subdued">
                  {set.summary}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>{new Date(set.updatedAt).toLocaleString()}</IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack gap="200">
                  <Button
                    variant="plain"
                    onClick={() => openRename(set)}
                    accessibilityLabel={`Rename ${set.name}`}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => setDeleteTarget(set)}
                    accessibilityLabel={`Delete ${set.name}`}
                  >
                    Delete
                  </Button>
                </InlineStack>
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>

      <Modal
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title="Rename edit-set"
        primaryAction={{
          content: "Save",
          loading: renameFetcher.state !== "idle",
          disabled: renameValue.trim().length === 0,
          onAction: confirmRename,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setRenameTarget(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {renameErrors.length > 0 ? (
              <Banner tone="critical" title="Could not rename">
                <BlockStack gap="100">
                  {renameErrors.map((message) => (
                    <Text as="p" key={message}>
                      {message}
                    </Text>
                  ))}
                </BlockStack>
              </Banner>
            ) : null}
            <TextField
              label="Name"
              autoComplete="off"
              value={renameValue}
              onChange={setRenameValue}
              maxLength={50}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete edit-set"
        primaryAction={{
          content: "Delete",
          destructive: true,
          loading: deleteFetcher.state !== "idle",
          onAction: confirmDelete,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeleteTarget(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            Delete the edit-set {deleteTarget?.name ? `"${deleteTarget.name}"` : ""}? This does not
            affect any product or past job.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
