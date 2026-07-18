// Edit-set types, server-side validation, and after-value computation. Pure
// and unit-tested; carries the price-math and validation safety guarantees.
// See the operation table in docs/api-contracts.md.

export type PriceOpKind = "set" | "adjust_percent" | "adjust_amount";
export type MetafieldType =
  "single_line_text_field" | "number_integer" | "number_decimal" | "boolean";

export interface PriceOperation {
  field: "price";
  op: PriceOpKind;
  value: string;
}

export interface StatusOperation {
  field: "status";
  op: "set";
  value: string;
}

export interface TagOperation {
  field: "tags";
  op: "add" | "remove";
  value: string;
}

export interface MetafieldOperation {
  field: "metafield";
  op: "set";
  namespace: string;
  key: string;
  type: MetafieldType;
  value: string;
}

export type EditOperation = PriceOperation | StatusOperation | TagOperation | MetafieldOperation;

export interface EditSet {
  operations: EditOperation[];
}

export type ValidationResult =
  { valid: true; editSet: EditSet } | { valid: false; errors: string[] };

const STATUS_VALUES = ["ACTIVE", "DRAFT", "ARCHIVED"];
const METAFIELD_TYPES: MetafieldType[] = [
  "single_line_text_field",
  "number_integer",
  "number_decimal",
  "boolean",
];
const DECIMAL = /^-?\d+(\.\d+)?$/;
const NS_KEY = /^[A-Za-z0-9_-]{2,64}$/;

function isDecimal(value: string): boolean {
  return DECIMAL.test(value.trim());
}

function metafieldValueValid(type: MetafieldType, value: string): boolean {
  const trimmed = value.trim();
  switch (type) {
    case "single_line_text_field":
      return trimmed.length > 0 && trimmed.length <= 255;
    case "number_integer":
      return /^-?\d+$/.test(trimmed);
    case "number_decimal":
      return DECIMAL.test(trimmed);
    case "boolean":
      return trimmed === "true" || trimmed === "false";
    default:
      return false;
  }
}

function validateOperation(raw: unknown, errors: string[]): EditOperation | null {
  if (typeof raw !== "object" || raw === null) {
    errors.push("Each operation must be an object.");
    return null;
  }

  const op = raw as Record<string, unknown>;
  const field = op.field;

  if (field === "price") {
    const kind = op.op;
    const value = String(op.value ?? "").trim();
    if (kind !== "set" && kind !== "adjust_percent" && kind !== "adjust_amount") {
      errors.push("Price operation must be set, adjust_percent, or adjust_amount.");
      return null;
    }
    if (!isDecimal(value)) {
      errors.push("Price value must be a number.");
      return null;
    }
    const numeric = Number(value);
    if (kind === "set" && numeric < 0) {
      errors.push("Price set value must be zero or more.");
      return null;
    }
    if (kind === "adjust_percent" && (numeric < -99 || numeric > 1000)) {
      errors.push("Percent adjustment must be between -99 and 1000.");
      return null;
    }
    return { field: "price", op: kind, value };
  }

  if (field === "status") {
    const value = String(op.value ?? "");
    if (op.op !== "set" || !STATUS_VALUES.includes(value)) {
      errors.push("Status must be set to ACTIVE, DRAFT, or ARCHIVED.");
      return null;
    }
    return { field: "status", op: "set", value };
  }

  if (field === "tags") {
    const kind = op.op;
    const value = String(op.value ?? "").trim();
    if (kind !== "add" && kind !== "remove") {
      errors.push("Tag operation must be add or remove.");
      return null;
    }
    if (value.length < 1 || value.length > 255 || value.includes(",")) {
      errors.push("Tag must be 1 to 255 characters and contain no commas.");
      return null;
    }
    return { field: "tags", op: kind, value };
  }

  if (field === "metafield") {
    const namespace = String(op.namespace ?? "").trim();
    const key = String(op.key ?? "").trim();
    const type = op.type as MetafieldType;
    const value = String(op.value ?? "");
    if (op.op !== "set") {
      errors.push("Metafield operation must be set.");
      return null;
    }
    if (!NS_KEY.test(namespace) || !NS_KEY.test(key)) {
      errors.push("Metafield namespace and key must be 2 to 64 letters, numbers, _ or -.");
      return null;
    }
    if (!METAFIELD_TYPES.includes(type)) {
      errors.push("Unsupported metafield type.");
      return null;
    }
    if (!metafieldValueValid(type, value)) {
      errors.push(`Metafield value is not a valid ${type}.`);
      return null;
    }
    return { field: "metafield", op: "set", namespace, key, type, value: value.trim() };
  }

  errors.push("Unknown edit field.");
  return null;
}

export function validateEditSet(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as EditSet).operations)) {
    return { valid: false, errors: ["An edit set with at least one operation is required."] };
  }

  const rawOps = (raw as { operations: unknown[] }).operations;
  if (rawOps.length < 1 || rawOps.length > 4) {
    return { valid: false, errors: ["An edit set must have 1 to 4 operations."] };
  }

  const operations: EditOperation[] = [];
  const seenFields = new Set<string>();

  for (const rawOp of rawOps) {
    const operation = validateOperation(rawOp, errors);
    if (!operation) continue;
    if (seenFields.has(operation.field)) {
      errors.push(`Only one ${operation.field} operation is allowed.`);
      continue;
    }
    seenFields.add(operation.field);
    operations.push(operation);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, editSet: { operations } };
}

// ---------------------------------------------------------------------------
// After-value computation (staging). Resolves relative adjustments to absolute
// target values and snapshots the before-values the edit will overwrite.

export interface VariantPrice {
  id: string;
  price: string;
}

export interface TagSnapshot {
  list: string[];
  delta: string[];
}

export interface MetafieldSnapshot {
  namespace: string;
  key: string;
  type: MetafieldType;
  value: string | null;
}

// Only the fields the edit touches are captured (docs/architecture.md).
export interface Snapshot {
  variants?: VariantPrice[];
  status?: string;
  tags?: TagSnapshot;
  metafield?: MetafieldSnapshot | null;
}

export interface ProductState {
  status: string;
  tags: string[];
  variants: VariantPrice[];
  metafield?: { value: string; type: string } | null;
}

export interface ItemComputation {
  status: "pending" | "skipped_unchanged" | "invalid";
  before: Snapshot;
  after: Snapshot;
  message?: string;
}

// Round half away from zero to 2 decimals, guarding binary-float error.
export function roundHalfUp2(amount: number): number {
  const scaled = amount * 100;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9);
  return rounded / 100;
}

function fmt(price: string | number): string {
  return roundHalfUp2(Number(price)).toFixed(2);
}

function computePriceNumber(currentPrice: string, op: PriceOperation): number {
  const base = Number(currentPrice);
  const value = Number(op.value);
  if (op.op === "set") return roundHalfUp2(value);
  if (op.op === "adjust_percent") return roundHalfUp2(base * (1 + value / 100));
  return roundHalfUp2(base + value);
}

export function applyTagOp(current: string[], op: "add" | "remove", tag: string): TagSnapshot {
  if (op === "add") {
    if (current.includes(tag)) return { list: current, delta: [] };
    return { list: [...current, tag], delta: [tag] };
  }
  if (!current.includes(tag)) return { list: current, delta: [] };
  return { list: current.filter((entry) => entry !== tag), delta: [tag] };
}

// Compute a product's before/after snapshot for an edit set. Absolute values
// only; relative adjustments are resolved here at staging time.
export function computeItem(current: ProductState, editSet: EditSet): ItemComputation {
  const before: Snapshot = {};
  const after: Snapshot = {};
  let changed = false;
  let invalidMessage: string | null = null;

  for (const op of editSet.operations) {
    if (op.field === "price") {
      before.variants = current.variants.map((variant) => ({ ...variant }));
      const nextVariants: VariantPrice[] = [];
      for (const variant of current.variants) {
        const nextNumber = computePriceNumber(variant.price, op);
        if (nextNumber < 0) {
          invalidMessage = "A resulting price would be negative.";
        }
        const nextPrice = nextNumber.toFixed(2);
        if (fmt(variant.price) !== nextPrice) changed = true;
        nextVariants.push({ id: variant.id, price: nextPrice });
      }
      after.variants = nextVariants;
    } else if (op.field === "status") {
      before.status = current.status;
      after.status = op.value;
      if (current.status !== op.value) changed = true;
    } else if (op.field === "tags") {
      const result = applyTagOp(current.tags, op.op, op.value);
      before.tags = { list: current.tags, delta: result.delta };
      after.tags = { list: result.list, delta: result.delta };
      if (result.delta.length > 0) changed = true;
    } else {
      const currentValue = current.metafield?.value ?? null;
      before.metafield = {
        namespace: op.namespace,
        key: op.key,
        type: op.type,
        value: currentValue,
      };
      after.metafield = {
        namespace: op.namespace,
        key: op.key,
        type: op.type,
        value: op.value,
      };
      if (currentValue !== op.value) changed = true;
    }
  }

  if (invalidMessage) {
    return { status: "invalid", before, after, message: invalidMessage };
  }
  if (!changed) {
    return { status: "skipped_unchanged", before, after };
  }
  return { status: "pending", before, after };
}
