import { parseAmountToMinor } from "./money-input";

/**
 * Stock and purchasing (migration 150): reading what the database returns, checking what a form sends, and the words the screens use. Pure, so it
 * is tested without a server. The database checks everything again on every call; nothing here is trusted for permission or for money.
 */

export const ITEM_KINDS = ["food", "drink", "minibar", "linen", "toiletries", "cleaning", "other"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABEL: Record<ItemKind, string> = {
  food: "Food",
  drink: "Drink",
  minibar: "Minibar",
  linen: "Linen",
  toiletries: "Toiletries",
  cleaning: "Cleaning",
  other: "Other",
};

export const USAGE_REASONS = ["minibar", "housekeeping", "linen", "toiletries", "kitchen", "maintenance", "other"] as const;
export const WASTE_REASONS = ["expired", "damaged", "spillage", "spoiled", "theft", "other"] as const;
export const OUT_KINDS = ["usage", "waste"] as const;
export type OutKind = (typeof OUT_KINDS)[number];

export const PURCHASE_LINE_SLOTS = 8;
export const RECIPE_LINE_SLOTS = 6;
export const MAX_QTY = 999_999_999;

// ---- wording ---------------------------------------------------------------------------------

export type InvErrorCode =
  | "inv_forbidden"
  | "inv_off"
  | "inv_invalid"
  | "inv_name_taken"
  | "inv_limit"
  | "inv_short"
  | "inv_supplier"
  | "inv_reused"
  | "inv_failed";

export const INV_ERROR_MESSAGES: Record<InvErrorCode, string> = {
  inv_forbidden:
    "You do not have permission to do that here. Setting up items, suppliers and recipes, and recording purchases, needs the owner or general manager.",
  inv_off: "Stock and purchasing is switched off for your hotel group. Your items and history are kept. Contact the platform.",
  inv_invalid: "Check the details and try again. Quantities use up to three decimals, and an item can appear only once.",
  inv_name_taken: "That name is already in use here. Choose another.",
  inv_limit: "This hotel has reached the most it can hold of that. Switch something off or reuse it.",
  inv_short: "There is not enough in stock for that. Record a count if the shelf holds more than the system shows.",
  inv_supplier: "That supplier is switched off or not found. Choose another or leave it blank.",
  inv_reused: "That form was already sent with other details. Reload the page and try again.",
  inv_failed: "That did not work. Reload the page and try again.",
};

export const INV_OK_MESSAGES = {
  inv_saved: "Saved.",
  inv_purchase: "Purchase recorded. Stock has gone up.",
  inv_out: "Recorded. Stock has gone down.",
  inv_count: "Count saved. Differences were written to the history.",
  inv_recipe: "Recipe saved. Each sale now takes these amounts from stock.",
} as const;
export type InvOkCode = keyof typeof INV_OK_MESSAGES;

/** Turns a database refusal into a code; raw database text never reaches the browser. */
export function classifyInvError(message: string): InvErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "inv_reused";
  if (/NOT_FOUND/.test(message)) return "inv_forbidden";
  if (/inventory off/.test(message)) return "inv_off";
  if (/POLICY_VIOLATION: name taken/.test(message)) return "inv_name_taken";
  if (/POLICY_VIOLATION: (limit|too many)/.test(message)) return "inv_limit";
  if (/POLICY_VIOLATION: not enough stock/.test(message)) return "inv_short";
  if (/POLICY_VIOLATION: supplier/.test(message)) return "inv_supplier";
  if (/POLICY_VIOLATION/.test(message)) return "inv_invalid";
  return "inv_failed";
}

// ---- reading what the database returns ----------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** numeric columns arrive as numbers or as decimal text */
const dec = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0;
const decOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : dec(v));
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);
const itemKind = (v: unknown): ItemKind => ((ITEM_KINDS as readonly string[]).includes(str(v)) ? (str(v) as ItemKind) : "other");

export type StockItem = {
  id: string;
  name: string;
  unit: string;
  kind: ItemKind;
  lowLevel: number;
  quantity: number;
  isActive: boolean;
  low: boolean;
};
export function parseItems(raw: unknown): StockItem[] {
  return arr(raw).map((r) => {
    const lowLevel = dec(r.low_level);
    const quantity = dec(r.quantity);
    return {
      id: str(r.id),
      name: str(r.name),
      unit: str(r.unit),
      kind: itemKind(r.kind),
      lowLevel,
      quantity,
      isActive: r.is_active !== false,
      low: lowLevel > 0 && quantity <= lowLevel,
    };
  });
}

export type StockSupplier = { id: string; name: string; phone: string | null; note: string | null; isActive: boolean };
export function parseSuppliers(raw: unknown): StockSupplier[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    name: str(r.name),
    phone: strOrNull(r.phone),
    note: strOrNull(r.note),
    isActive: r.is_active !== false,
  }));
}

export type StockPurchase = { id: string; supplierId: string | null; reference: string | null; purchasedOn: string; totalMinor: number };
export function parsePurchases(raw: unknown): StockPurchase[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    supplierId: strOrNull(r.supplier_id),
    reference: strOrNull(r.reference),
    purchasedOn: str(r.purchased_on),
    totalMinor: dec(r.total_minor),
  }));
}

export type StockMovement = {
  id: string;
  itemId: string;
  kind: string;
  change: number;
  balanceAfter: number;
  reason: string | null;
  createdAt: string;
};
export function parseMovements(raw: unknown): StockMovement[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    itemId: str(r.item_id),
    kind: str(r.kind),
    change: dec(r.change),
    balanceAfter: dec(r.balance_after),
    reason: strOrNull(r.reason),
    createdAt: str(r.created_at),
  }));
}

export type RecipeLine = { posItemId: string; stockItemId: string; quantity: number };
export function parseRecipes(raw: unknown): RecipeLine[] {
  return arr(raw).map((r) => ({ posItemId: str(r.pos_item_id), stockItemId: str(r.stock_item_id), quantity: dec(r.quantity) }));
}

export type StockReportRow = {
  itemId: string;
  name: string;
  unit: string;
  kind: ItemKind;
  onHand: number;
  low: boolean;
  bought: number;
  sold: number;
  used: number;
  wasted: number;
  countDifference: number;
  /** null when this person may not see money */
  spentMinor: number | null;
  wasteValueMinor: number | null;
};
export type StockReport = { from: string; to: string; items: StockReportRow[]; spentMinor: number | null };
export function parseStockReport(raw: unknown): StockReport {
  const r = rec(raw) ?? {};
  return {
    from: str(r.from),
    to: str(r.to),
    spentMinor: decOrNull(r.spent_minor),
    items: arr(r.items).map((x) => ({
      itemId: str(x.item_id),
      name: str(x.name),
      unit: str(x.unit),
      kind: itemKind(x.kind),
      onHand: dec(x.on_hand),
      low: x.low === true,
      bought: dec(x.bought),
      sold: dec(x.sold),
      used: dec(x.used),
      wasted: dec(x.wasted),
      countDifference: dec(x.count_difference),
      spentMinor: decOrNull(x.spent_minor),
      wasteValueMinor: decOrNull(x.waste_value_minor),
    })),
  };
}

/** A quantity for the screen: no trailing zeros, at most three decimals. */
export function formatQty(n: number): string {
  return String(Number(n.toFixed(3)));
}

export const MOVEMENT_LABEL: Record<string, string> = {
  purchase: "Bought",
  sale: "Sold",
  usage: "Used",
  waste: "Wasted",
  count: "Count",
};

// ---- checking what a form sends -----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
type Raw = Record<string, FormDataEntryValue | undefined>;
type Parsed<T> = { ok: true; value: T } | { ok: false; code: InvErrorCode };
const text = (v: FormDataEntryValue | undefined): string => (typeof v === "string" ? v.trim() : "");
const bad = (): { ok: false; code: InvErrorCode } => ({ ok: false, code: "inv_invalid" });
const checked = (v: FormDataEntryValue | undefined): boolean => v === "on" || v === "true";

/** A positive quantity with at most three decimals, or null. A comma is read as a decimal point. */
export function parseQty(input: string, allowZero = false): number | null {
  const s = input.trim().replace(",", ".");
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  if (n > MAX_QTY || (!allowZero && n <= 0)) return null;
  return n;
}

export function parseItemForm(raw: Raw): Parsed<{
  propertyId: string;
  itemId: string | null;
  name: string;
  unit: string;
  kind: ItemKind;
  low: number;
  active: boolean;
}> {
  const propertyId = text(raw.propertyId);
  const itemId = text(raw.itemId) || null;
  const name = text(raw.name);
  const unit = text(raw.unit);
  const kind = text(raw.kind);
  const low = parseQty(text(raw.low) || "0", true);
  if (
    !UUID.test(propertyId) ||
    (itemId && !UUID.test(itemId)) ||
    name.length < 1 ||
    name.length > 80 ||
    unit.length < 1 ||
    unit.length > 20 ||
    !(ITEM_KINDS as readonly string[]).includes(kind) ||
    low === null
  )
    return bad();
  return { ok: true, value: { propertyId, itemId, name, unit, kind: kind as ItemKind, low, active: checked(raw.active) } };
}

export function parseSupplierForm(raw: Raw): Parsed<{
  propertyId: string;
  supplierId: string | null;
  name: string;
  phone: string | null;
  note: string | null;
  active: boolean;
}> {
  const propertyId = text(raw.propertyId);
  const supplierId = text(raw.supplierId) || null;
  const name = text(raw.name);
  const phone = text(raw.phone);
  const note = text(raw.note);
  if (
    !UUID.test(propertyId) ||
    (supplierId && !UUID.test(supplierId)) ||
    name.length < 1 ||
    name.length > 80 ||
    phone.length > 40 ||
    note.length > 200
  )
    return bad();
  return { ok: true, value: { propertyId, supplierId, name, phone: phone || null, note: note || null, active: checked(raw.active) } };
}

export function parseOutForm(
  raw: Raw,
): Parsed<{ itemId: string; kind: OutKind; quantity: number; reason: string; note: string | null; key: string }> {
  const itemId = text(raw.itemId);
  const kind = text(raw.kind);
  const quantity = parseQty(text(raw.quantity));
  const reason = text(raw.reason);
  const note = text(raw.note);
  const key = text(raw.key);
  if (!UUID.test(itemId) || !(OUT_KINDS as readonly string[]).includes(kind) || quantity === null || note.length > 200 || !KEY.test(key))
    return bad();
  const reasons: readonly string[] = kind === "usage" ? USAGE_REASONS : WASTE_REASONS;
  if (!reasons.includes(reason)) return bad();
  return { ok: true, value: { itemId, kind: kind as OutKind, quantity, reason, note: note || null, key } };
}

export type PurchaseLineInput = { item: string; quantity: number; unit_cost_minor: number };
export function parsePurchaseForm(raw: Raw): Parsed<{
  propertyId: string;
  supplierId: string | null;
  reference: string | null;
  note: string | null;
  lines: PurchaseLineInput[];
  key: string;
}> {
  const propertyId = text(raw.propertyId);
  const supplierId = text(raw.supplierId) || null;
  const reference = text(raw.reference);
  const note = text(raw.note);
  const key = text(raw.key);
  if (!UUID.test(propertyId) || (supplierId && !UUID.test(supplierId)) || reference.length > 60 || note.length > 200 || !KEY.test(key))
    return bad();
  const lines: PurchaseLineInput[] = [];
  const seen = new Set<string>();
  for (let n = 1; n <= PURCHASE_LINE_SLOTS; n++) {
    const item = text(raw[`item_${n}`]);
    const qtyText = text(raw[`qty_${n}`]);
    const costText = text(raw[`cost_${n}`]);
    if (item === "" && qtyText === "" && costText === "") continue; // an empty row
    const quantity = parseQty(qtyText);
    const cost = /^[₦\s]*0*([.,]0{0,2})?$/.test(costText) ? 0 : parseAmountToMinor(costText); // blank or zero means no cost recorded
    if (!UUID.test(item) || quantity === null || cost === null || seen.has(item)) return bad();
    seen.add(item);
    lines.push({ item, quantity, unit_cost_minor: cost });
  }
  if (lines.length === 0) return bad();
  return { ok: true, value: { propertyId, supplierId, reference: reference || null, note: note || null, lines, key } };
}

/** One input per item named `count_<id>`; a blank box means the item was not counted. */
export function parseCountForm(
  raw: Raw,
): Parsed<{ propertyId: string; note: string | null; counts: { item: string; counted: number }[]; key: string }> {
  const propertyId = text(raw.propertyId);
  const note = text(raw.note);
  const key = text(raw.key);
  if (!UUID.test(propertyId) || note.length > 200 || !KEY.test(key)) return bad();
  const counts: { item: string; counted: number }[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!name.startsWith("count_")) continue;
    const id = name.slice(6);
    const s = text(value);
    if (s === "") continue;
    const counted = parseQty(s, true);
    if (!UUID.test(id) || counted === null) return bad();
    counts.push({ item: id, counted });
  }
  if (counts.length === 0 || counts.length > 400) return bad();
  return { ok: true, value: { propertyId, note: note || null, counts, key } };
}

export function parseRecipeForm(raw: Raw): Parsed<{ posItemId: string; lines: { item: string; quantity: number }[] }> {
  const posItemId = text(raw.posItemId);
  if (!UUID.test(posItemId)) return bad();
  const lines: { item: string; quantity: number }[] = [];
  const seen = new Set<string>();
  for (let n = 1; n <= RECIPE_LINE_SLOTS; n++) {
    const item = text(raw[`item_${n}`]);
    const qtyText = text(raw[`qty_${n}`]);
    if (item === "" && qtyText === "") continue;
    const quantity = parseQty(qtyText);
    if (!UUID.test(item) || quantity === null || seen.has(item)) return bad();
    seen.add(item);
    lines.push({ item, quantity });
  }
  return { ok: true, value: { posItemId, lines } }; // no lines clears the recipe
}
