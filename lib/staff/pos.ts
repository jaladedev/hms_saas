import { parseAmountToMinor } from "./money-input";

/**
 * Restaurant, bar and point of sale (migration 148): reading what the database returns, checking what a form sends, and the words the
 * screens use. Pure, so it is tested without a server. The database checks everything again on every call; nothing here is trusted
 * for permission or for money.
 */

export const PLACE_KINDS = ["table", "bar", "room_service"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
export const PLACE_KIND_LABEL: Record<PlaceKind, string> = { table: "Table", bar: "Bar", room_service: "Room service" };

export const PAY_METHODS = ["cash", "pos", "bank_transfer", "other"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  cash: "Cash",
  pos: "Card (POS machine)",
  bank_transfer: "Bank transfer",
  other: "Other",
};

export type KitchenStatus = "new" | "preparing" | "ready" | "served" | "cancelled";
export const KITCHEN_LABEL: Record<KitchenStatus, string> = {
  new: "New",
  preparing: "Preparing",
  ready: "Ready",
  served: "Served",
  cancelled: "Cancelled",
};
/** The one step a line can take next, and the button that takes it. */
export const KITCHEN_NEXT: Partial<Record<KitchenStatus, { to: KitchenStatus; button: string }>> = {
  new: { to: "preparing", button: "Start" },
  preparing: { to: "ready", button: "Ready" },
  ready: { to: "served", button: "Served" },
};

export const MAX_QUANTITY = 100;
export const MAX_PRICE_MINOR = 1_000_000_000;

// ---- wording ---------------------------------------------------------------------------------

export type PosErrorCode =
  | "pos_forbidden"
  | "pos_off"
  | "pos_invalid"
  | "pos_name_taken"
  | "pos_limit"
  | "pos_place_off"
  | "pos_item_off"
  | "pos_closed"
  | "pos_empty"
  | "pos_too_large"
  | "pos_not_in_house"
  | "pos_need_folio"
  | "pos_step"
  | "pos_reused"
  | "pos_failed";

export const POS_ERROR_MESSAGES: Record<PosErrorCode, string> = {
  pos_forbidden: "You do not have permission to do that here. Voiding an order whose food has started needs a manager.",
  pos_off: "Restaurant and bar is switched off for your hotel group. Your menu and orders are kept. Contact the platform.",
  pos_invalid: "Check the details and try again.",
  pos_name_taken: "That name is already in use here. Choose another.",
  pos_limit: "This hotel has reached the most it can hold of that. Switch something off or reuse it.",
  pos_place_off: "That place is switched off. Choose another.",
  pos_item_off: "That item is switched off and cannot be added.",
  pos_closed: "That order is already paid, posted or void. Nothing was changed.",
  pos_empty: "There is nothing on this order to bill. Add an item first.",
  pos_too_large: "An order can hold at most 100 lines and ₦10,000,000 before tax.",
  pos_not_in_house: "That guest is not checked in, so the bill cannot go on their room.",
  pos_need_folio: "Putting a bill on a room also needs the permission to post charges to a guest's bill. Ask the front desk.",
  pos_step: "The kitchen status cannot move that way from where it is now.",
  pos_reused: "That form was already sent with other details. Reload the page and try again.",
  pos_failed: "That did not work. Reload the page and try again.",
};

export const POS_OK_MESSAGES = {
  pos_saved: "Saved.",
  pos_opened: "Order opened.",
  pos_line_added: "Added to the order.",
  pos_status: "Kitchen status updated.",
  pos_paid: "Paid. The bill is closed.",
  pos_posted: "Posted to the guest's room bill. The bill is closed.",
  pos_voided: "Order voided.",
} as const;
export type PosOkCode = keyof typeof POS_OK_MESSAGES;

/** Turns a database refusal into a code; raw database text never reaches the browser. */
export function classifyPosError(message: string): PosErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "pos_reused";
  if (/FORBIDDEN: folio\.charge/.test(message)) return "pos_need_folio";
  if (/NOT_FOUND/.test(message)) return "pos_forbidden";
  if (/restaurant pos off/.test(message)) return "pos_off";
  if (/POLICY_VIOLATION: name taken/.test(message)) return "pos_name_taken";
  if (/POLICY_VIOLATION: limit|too many/.test(message)) return "pos_limit";
  if (/POLICY_VIOLATION: place off/.test(message)) return "pos_place_off";
  if (/POLICY_VIOLATION: item off/.test(message)) return "pos_item_off";
  if (/POLICY_VIOLATION: order too large/.test(message)) return "pos_too_large";
  if (/POLICY_VIOLATION: nothing to (pay|post)/.test(message)) return "pos_empty";
  if (/INVALID_STATE: guest not in house/.test(message)) return "pos_not_in_house";
  if (/INVALID_STATE: (new|preparing|ready|served|cancelled) to /.test(message)) return "pos_step";
  if (/INVALID_STATE/.test(message)) return "pos_closed";
  if (/POLICY_VIOLATION/.test(message)) return "pos_invalid";
  return "pos_failed";
}

// ---- reading what the database returns ------------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);
const kind = (v: unknown): PlaceKind => ((PLACE_KINDS as readonly string[]).includes(str(v)) ? (str(v) as PlaceKind) : "table");
const kitchen = (v: unknown): KitchenStatus =>
  (["new", "preparing", "ready", "served", "cancelled"] as const).find((s) => s === v) ?? "new";

export type MenuCategory = { id: string; name: string; sortOrder: number; isActive: boolean };
export type MenuItem = { id: string; categoryId: string; name: string; priceMinor: number; sortOrder: number; isActive: boolean };
export type MenuPlace = { id: string; name: string; kind: PlaceKind; isActive: boolean };
export type Menu = { categories: MenuCategory[]; items: MenuItem[]; places: MenuPlace[] };

export function parseMenu(data: unknown): Menu {
  const d = rec(data) ?? {};
  return {
    categories: arr(d.categories).map((c) => ({
      id: str(c.id),
      name: str(c.name),
      sortOrder: num(c.sort_order),
      isActive: c.is_active === true,
    })),
    items: arr(d.items).map((i) => ({
      id: str(i.id),
      categoryId: str(i.category_id),
      name: str(i.name),
      priceMinor: num(i.price_minor),
      sortOrder: num(i.sort_order),
      isActive: i.is_active === true,
    })),
    places: arr(d.places).map((p) => ({ id: str(p.id), name: str(p.name), kind: kind(p.kind), isActive: p.is_active === true })),
  };
}

/** Categories with their items, in menu order. With activeOnly, switched-off items and categories (and categories left empty) are dropped. */
export function menuByCategory(menu: Menu, activeOnly: boolean): { category: MenuCategory; items: MenuItem[] }[] {
  return menu.categories
    .filter((c) => !activeOnly || c.isActive)
    .map((category) => ({ category, items: menu.items.filter((i) => i.categoryId === category.id && (!activeOnly || i.isActive)) }))
    .filter((g) => !activeOnly || g.items.length > 0);
}

export type OpenOrder = {
  id: string;
  orderNo: string;
  placeName: string;
  placeKind: PlaceKind;
  guestLabel: string | null;
  openedAt: string;
  lines: number;
  subtotalMinor: number;
};
export function parseOpenOrders(data: unknown): OpenOrder[] {
  return arr(data).map((o) => ({
    id: str(o.id),
    orderNo: str(o.order_no),
    placeName: str(o.place_name),
    placeKind: kind(o.place_kind),
    guestLabel: strOrNull(o.guest_label),
    openedAt: str(o.opened_at),
    lines: num(o.lines),
    subtotalMinor: num(o.subtotal_minor),
  }));
}

export type OrderLine = {
  id: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  note: string | null;
  kitchenStatus: KitchenStatus;
};
export type OrderDetail = {
  id: string;
  propertyId: string;
  orderNo: string;
  status: "open" | "paid" | "posted" | "void";
  placeName: string;
  guestLabel: string | null;
  currency: string;
  openedAt: string;
  closedAt: string | null;
  voidReason: string | null;
  reservationId: string | null;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  estimate: boolean;
  paymentMethod: string | null;
  lines: OrderLine[];
};
export function parseOrder(data: unknown): OrderDetail | null {
  const d = rec(data);
  if (!d || !str(d.id)) return null;
  const status = (["open", "paid", "posted", "void"] as const).find((s) => s === d.status);
  if (!status) return null;
  return {
    id: str(d.id),
    propertyId: str(d.property_id),
    orderNo: str(d.order_no),
    status,
    placeName: str(d.place_name),
    guestLabel: strOrNull(d.guest_label),
    currency: str(d.currency) || "NGN",
    openedAt: str(d.opened_at),
    closedAt: strOrNull(d.closed_at),
    voidReason: strOrNull(d.void_reason),
    reservationId: strOrNull(d.reservation_id),
    subtotalMinor: num(d.subtotal_minor),
    taxMinor: num(d.tax_minor),
    totalMinor: num(d.total_minor),
    estimate: d.estimate === true,
    paymentMethod: strOrNull(d.payment_method),
    lines: arr(d.lines).map((l) => ({
      id: str(l.id),
      name: str(l.name),
      quantity: num(l.quantity),
      unitPriceMinor: num(l.unit_price_minor),
      note: strOrNull(l.note),
      kitchenStatus: kitchen(l.kitchen_status),
    })),
  };
}

export type KitchenLine = {
  lineId: string;
  orderId: string;
  orderNo: string;
  placeName: string;
  name: string;
  quantity: number;
  note: string | null;
  status: KitchenStatus;
  createdAt: string;
};
export function parseKitchen(data: unknown): KitchenLine[] {
  return arr(data).map((l) => ({
    lineId: str(l.line_id),
    orderId: str(l.order_id),
    orderNo: str(l.order_no),
    placeName: str(l.place_name),
    name: str(l.name),
    quantity: num(l.quantity),
    note: strOrNull(l.note),
    status: kitchen(l.kitchen_status),
    createdAt: str(l.created_at),
  }));
}

export type SalesReport = {
  from: string;
  to: string;
  tableOrders: number;
  tableSubtotalMinor: number;
  tableTaxMinor: number;
  tableTotalMinor: number;
  roomOrders: number;
  roomSubtotalMinor: number;
  roomTaxMinor: number;
  roomTotalMinor: number;
  voidedOrders: number;
  byDay: { day: string; orders: number; tableTotalMinor: number; roomTotalMinor: number }[];
  byMethod: { method: string; orders: number; totalMinor: number }[];
  topItems: { name: string; quantity: number; salesMinor: number }[];
};
export function parseSales(data: unknown): SalesReport | null {
  const d = rec(data);
  const t = rec(d?.totals);
  if (!d || !t) return null;
  return {
    from: str(d.from),
    to: str(d.to),
    tableOrders: num(t.table_orders),
    tableSubtotalMinor: num(t.table_subtotal_minor),
    tableTaxMinor: num(t.table_tax_minor),
    tableTotalMinor: num(t.table_total_minor),
    roomOrders: num(t.room_orders),
    roomSubtotalMinor: num(t.room_subtotal_minor),
    roomTaxMinor: num(t.room_tax_minor),
    roomTotalMinor: num(t.room_total_minor),
    voidedOrders: num(d.voided_orders),
    byDay: arr(d.by_day).map((r) => ({
      day: str(r.day),
      orders: num(r.orders),
      tableTotalMinor: num(r.table_total_minor),
      roomTotalMinor: num(r.room_total_minor),
    })),
    byMethod: arr(d.table_by_method).map((r) => ({ method: str(r.method), orders: num(r.orders), totalMinor: num(r.total_minor) })),
    topItems: arr(d.top_items).map((r) => ({ name: str(r.name), quantity: num(r.quantity), salesMinor: num(r.sales_minor) })),
  };
}

/** "5 min", "1 h 10 min": how long a line has waited. A time in the future (clock drift) reads as "just now". */
export function waitText(createdAt: string, now: Date): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((now.getTime() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min`;
}

export function methodLabel(m: string): string {
  return (PAY_METHOD_LABEL as Record<string, string>)[m] ?? m;
}

// ---- checking what a form sends --------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: PosErrorCode };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
type Raw = Record<string, FormDataEntryValue | undefined>;
const text = (v: FormDataEntryValue | undefined): string => (typeof v === "string" ? v.trim() : "");
const bad = (): { ok: false; code: PosErrorCode } => ({ ok: false, code: "pos_invalid" });
const checked = (v: FormDataEntryValue | undefined): boolean => v === "on" || v === "true";
function intIn(v: FormDataEntryValue | undefined, min: number, max: number, fallback?: number): number | null {
  const s = text(v);
  if (s === "") return fallback ?? null;
  if (!/^-?\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

export function parseCategoryForm(
  raw: Raw,
): Parsed<{ propertyId: string; categoryId: string | null; name: string; sort: number; active: boolean }> {
  const propertyId = text(raw.propertyId);
  const categoryId = text(raw.categoryId) || null;
  const name = text(raw.name);
  const sort = intIn(raw.sort, 0, 1000, 0);
  if (!UUID.test(propertyId) || (categoryId && !UUID.test(categoryId)) || name.length < 1 || name.length > 60 || sort === null)
    return bad();
  return { ok: true, value: { propertyId, categoryId, name, sort, active: checked(raw.active) } };
}

export function parseItemForm(raw: Raw): Parsed<{
  propertyId: string;
  itemId: string | null;
  categoryId: string;
  name: string;
  priceMinor: number;
  sort: number;
  active: boolean;
}> {
  const propertyId = text(raw.propertyId);
  const itemId = text(raw.itemId) || null;
  const categoryId = text(raw.categoryId);
  const name = text(raw.name);
  const priceMinor = parseAmountToMinor(text(raw.price));
  const sort = intIn(raw.sort, 0, 1000, 0);
  if (
    !UUID.test(propertyId) ||
    (itemId && !UUID.test(itemId)) ||
    !UUID.test(categoryId) ||
    name.length < 1 ||
    name.length > 80 ||
    priceMinor === null ||
    priceMinor > MAX_PRICE_MINOR ||
    sort === null
  ) {
    return bad();
  }
  return { ok: true, value: { propertyId, itemId, categoryId, name, priceMinor, sort, active: checked(raw.active) } };
}

export function parsePlaceForm(
  raw: Raw,
): Parsed<{ propertyId: string; placeId: string | null; name: string; kind: PlaceKind; active: boolean }> {
  const propertyId = text(raw.propertyId);
  const placeId = text(raw.placeId) || null;
  const name = text(raw.name);
  const k = text(raw.kind);
  if (
    !UUID.test(propertyId) ||
    (placeId && !UUID.test(placeId)) ||
    name.length < 1 ||
    name.length > 40 ||
    !(PLACE_KINDS as readonly string[]).includes(k)
  )
    return bad();
  return { ok: true, value: { propertyId, placeId, name, kind: k as PlaceKind, active: checked(raw.active) } };
}

export function parseOpenOrderForm(raw: Raw): Parsed<{ propertyId: string; placeId: string; label: string | null; key: string }> {
  const propertyId = text(raw.propertyId);
  const placeId = text(raw.placeId);
  const label = text(raw.label);
  const key = text(raw.key);
  if (!UUID.test(propertyId) || !UUID.test(placeId) || label.length > 60 || !KEY.test(key)) return bad();
  return { ok: true, value: { propertyId, placeId, label: label || null, key } };
}

export function parseLineForm(raw: Raw): Parsed<{ orderId: string; itemId: string; quantity: number; note: string | null; key: string }> {
  const orderId = text(raw.orderId);
  const itemId = text(raw.itemId);
  const quantity = intIn(raw.quantity, 1, MAX_QUANTITY, 1);
  const note = text(raw.note);
  const key = text(raw.key);
  if (!UUID.test(orderId) || !UUID.test(itemId) || quantity === null || note.length > 100 || !KEY.test(key)) return bad();
  return { ok: true, value: { orderId, itemId, quantity, note: note || null, key } };
}

export function parseStatusForm(raw: Raw): Parsed<{ orderId: string; lineId: string; status: KitchenStatus; back: string }> {
  const orderId = text(raw.orderId);
  const lineId = text(raw.lineId);
  const status = text(raw.status);
  const back = text(raw.back);
  if (!UUID.test(lineId) || !(["preparing", "ready", "served", "cancelled"] as const).some((s) => s === status)) return bad();
  if (orderId && !UUID.test(orderId)) return bad();
  return { ok: true, value: { orderId, lineId, status: status as KitchenStatus, back: back === "kitchen" ? "kitchen" : "order" } };
}

export function parsePayForm(raw: Raw): Parsed<{ orderId: string; method: PayMethod; reference: string | null; key: string }> {
  const orderId = text(raw.orderId);
  const method = text(raw.method);
  const reference = text(raw.reference);
  const key = text(raw.key);
  if (!UUID.test(orderId) || !(PAY_METHODS as readonly string[]).includes(method) || reference.length > 100 || !KEY.test(key)) return bad();
  return { ok: true, value: { orderId, method: method as PayMethod, reference: reference || null, key } };
}

export function parsePostForm(raw: Raw): Parsed<{ orderId: string; reservationId: string; key: string }> {
  const orderId = text(raw.orderId);
  const reservationId = text(raw.reservationId);
  const key = text(raw.key);
  if (!UUID.test(orderId) || !UUID.test(reservationId) || !KEY.test(key)) return bad();
  return { ok: true, value: { orderId, reservationId, key } };
}

export function parseVoidForm(raw: Raw): Parsed<{ orderId: string; reason: string }> {
  const orderId = text(raw.orderId);
  const reason = text(raw.reason);
  if (!UUID.test(orderId) || reason.length < 1 || reason.length > 200) return bad();
  return { ok: true, value: { orderId, reason } };
}

/** A day typed or linked into the report: a real calendar date, else the fallback. */
export function parseDay(v: string | undefined, fallback: string): string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fallback;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? fallback : v;
}
