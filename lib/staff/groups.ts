/**
 * Group bookings, step one (migration 150): reading what the database returns, checking what a form sends, and the words the screens use.
 * Pure, so it is tested without a server. The database checks everything again; nothing here is trusted for permission.
 */
type Raw = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; code: GroupErrorCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const bad = { ok: false, code: "group_invalid" } as const;

export const MAX_GROUP_ROOMS = 100;
export const MAX_GROUP_NIGHTS = 60;

export const GROUP_ERROR_MESSAGES = {
  group_forbidden: "You do not have permission to manage group bookings here.",
  group_off: "Group bookings are switched off for your hotel group. Your groups are kept. Contact the platform.",
  group_invalid:
    "Check the details. A group needs a name and a contact (up to 80 characters each), dates in the future with the release date on or before arrival, at most 60 nights, and 1 to 50 rooms of a type (100 in all).",
  group_unavailable:
    "There are not enough free rooms of that type for those dates. Nothing was held. Ask for fewer rooms or change the dates.",
  group_closed: "That group is already cancelled or released, so it cannot be changed. Create a new group if the rooms are needed again.",
  group_no_unit: "No room of that type is still held for this group.",
  group_booking_missing: "No booking at this hotel has that reference, or it is cancelled, expired or a no-show.",
  group_booking_dates: "That booking's stay is outside the group's dates. Link a booking that arrives and leaves within them.",
  group_booking_taken: "That booking is already linked to a name on a rooming list.",
  group_due_date: "Choose a due date from today up to a year ahead.",
  group_reason: "Give a reason of up to 200 characters.",
  group_nothing_to_invoice:
    "There is nothing to invoice. Link confirmed, checked-in or checked-out bookings to the rooming list first; a booking already on a live group invoice is skipped.",
  group_invoice_final: "That invoice is already paid or void and cannot change.",
  group_limit: "A rooming list holds at most 200 names.",
  group_reused: "That form was already sent with other details. Reload the page and try again.",
  group_failed: "That did not work. Reload the page and try again.",
} as const;
export type GroupErrorCode = keyof typeof GROUP_ERROR_MESSAGES;

export const GROUP_OK_MESSAGES = {
  group_created: "Group created. The rooms are held and cannot be sold until the release date.",
  group_updated: "Group saved.",
  group_cancelled: "Group cancelled. The held rooms are free again.",
  group_unit_used: "One held room was freed so you can book it for a guest. Make that booking now from Reservations.",
  group_rooming_added: "Name added to the rooming list.",
  group_rooming_removed: "Name removed from the rooming list.",
  group_invoice_issued: "Invoice issued to the company.",
  group_invoice_voided: "Invoice voided. Its bookings can be invoiced again.",
  group_invoice_paid: "Marked as paid by the company. The bookings' own payment status is not changed.",
  group_booking_linked: "Booking linked to that name. It keeps its own bill and payments.",
  group_booking_unlinked: "Booking unlinked from that name. The booking itself is unchanged.",
} as const;
export type GroupOkCode = keyof typeof GROUP_OK_MESSAGES;

/** Turns a database refusal into a code; raw database text never reaches the browser. */
export function classifyGroupError(message: string): GroupErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "group_reused";
  if (/NOT_FOUND/.test(message)) return "group_forbidden";
  if (/group bookings off/.test(message)) return "group_off";
  if (/ROOMS_UNAVAILABLE/.test(message)) return "group_unavailable";
  if (/INVALID_STATE: nothing to invoice/.test(message)) return "group_nothing_to_invoice";
  if (/INVALID_STATE: (paid|void)/.test(message)) return "group_invoice_final";
  if (/INVALID_STATE/.test(message)) return "group_closed";
  if (/POLICY_VIOLATION: due date/.test(message)) return "group_due_date";
  if (/POLICY_VIOLATION: reason/.test(message)) return "group_reason";
  if (/POLICY_VIOLATION: booking not found/.test(message)) return "group_booking_missing";
  if (/POLICY_VIOLATION: booking dates/.test(message)) return "group_booking_dates";
  if (/POLICY_VIOLATION: already linked/.test(message)) return "group_booking_taken";
  if (/POLICY_VIOLATION: no held room/.test(message)) return "group_no_unit";
  if (/POLICY_VIOLATION: limit/.test(message)) return "group_limit";
  if (/POLICY_VIOLATION/.test(message)) return "group_invalid";
  return "group_failed";
}

function realDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const nights = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export type CreateGroupForm = {
  propertyId: string;
  name: string;
  company: string | null;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  arrival: string;
  departure: string;
  release: string;
  notes: string | null;
  rooms: { room_type_id: string; quantity: number }[];
  key: string;
};

/** Room quantities come as fields named qty_<room type id>; empty or 0 means none of that type. */
export function parseCreateGroupForm(raw: Raw): Parsed<CreateGroupForm> {
  const propertyId = text(raw.propertyId);
  const name = text(raw.name);
  const company = text(raw.company);
  const contactName = text(raw.contactName);
  const phone = text(raw.contactPhone);
  const email = text(raw.contactEmail);
  const arrival = text(raw.arrival);
  const departure = text(raw.departure);
  const release = text(raw.release);
  const notes = text(raw.notes);
  const key = text(raw.key);
  if (!UUID.test(propertyId) || !KEY.test(key)) return bad;
  if (name.length < 1 || name.length > 80 || contactName.length < 1 || contactName.length > 80 || company.length > 80) return bad;
  if (phone && (phone.length < 3 || phone.length > 30)) return bad;
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+$/.test(email))) return bad;
  if (notes.length > 1000) return bad;
  if (!realDate(arrival) || !realDate(departure) || !realDate(release)) return bad;
  const n = nights(arrival, departure);
  if (n < 1 || n > MAX_GROUP_NIGHTS || release > arrival) return bad;
  const rooms: { room_type_id: string; quantity: number }[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("qty_")) continue;
    const id = k.slice(4);
    const s = text(v);
    if (s === "" || s === "0") continue;
    if (!UUID.test(id) || !/^\d{1,2}$/.test(s)) return bad;
    const q = Number(s);
    if (q < 1 || q > 50) return bad;
    rooms.push({ room_type_id: id, quantity: q });
    total += q;
  }
  if (rooms.length < 1 || rooms.length > 10 || total > MAX_GROUP_ROOMS) return bad;
  return {
    ok: true,
    value: {
      propertyId,
      name,
      company: company || null,
      contactName,
      contactPhone: phone || null,
      contactEmail: email || null,
      arrival,
      departure,
      release,
      notes: notes || null,
      rooms,
      key,
    },
  };
}

export type UpdateGroupForm = {
  groupId: string;
  company: string | null;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  release: string;
  notes: string | null;
};
export function parseUpdateGroupForm(raw: Raw): Parsed<UpdateGroupForm> {
  const groupId = text(raw.groupId);
  const company = text(raw.company);
  const contactName = text(raw.contactName);
  const phone = text(raw.contactPhone);
  const email = text(raw.contactEmail);
  const release = text(raw.release);
  const notes = text(raw.notes);
  if (!UUID.test(groupId) || !realDate(release)) return bad;
  if (contactName.length < 1 || contactName.length > 80 || company.length > 80 || notes.length > 1000) return bad;
  if (phone && (phone.length < 3 || phone.length > 30)) return bad;
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+$/.test(email))) return bad;
  return {
    ok: true,
    value: {
      groupId,
      company: company || null,
      contactName,
      contactPhone: phone || null,
      contactEmail: email || null,
      release,
      notes: notes || null,
    },
  };
}

export function parseGroupId(raw: unknown): string | null {
  const s = text(raw);
  return UUID.test(s) ? s : null;
}

export function parseUnitForm(raw: Raw): Parsed<{ groupId: string; roomTypeId: string }> {
  const groupId = text(raw.groupId);
  const roomTypeId = text(raw.roomTypeId);
  if (!UUID.test(groupId) || !UUID.test(roomTypeId)) return bad;
  return { ok: true, value: { groupId, roomTypeId } };
}

export function parseRoomingForm(raw: Raw): Parsed<{ groupId: string; guest: string; roomTypeId: string | null; notes: string | null }> {
  const groupId = text(raw.groupId);
  const guest = text(raw.guest);
  const roomTypeId = text(raw.roomTypeId);
  const notes = text(raw.notes);
  if (!UUID.test(groupId) || guest.length < 1 || guest.length > 80 || notes.length > 200) return bad;
  if (roomTypeId && !UUID.test(roomTypeId)) return bad;
  return { ok: true, value: { groupId, guest, roomTypeId: roomTypeId || null, notes: notes || null } };
}

export function parseLinkForm(raw: Raw): Parsed<{ groupId: string; entryId: string; reference: string }> {
  const groupId = text(raw.groupId);
  const entryId = text(raw.entryId);
  const reference = text(raw.reference);
  if (!UUID.test(groupId) || !UUID.test(entryId) || reference.length < 3 || reference.length > 40) return bad;
  return { ok: true, value: { groupId, entryId, reference } };
}

export const PAY_METHODS = ["bank_transfer", "cash", "pos", "other"] as const;
export const PAY_METHOD_LABEL: Record<string, string> = { bank_transfer: "Bank transfer", cash: "Cash", pos: "POS", other: "Other" };

export function parseIssueInvoiceForm(raw: Raw): Parsed<{ groupId: string; due: string; key: string }> {
  const groupId = text(raw.groupId);
  const due = text(raw.due);
  const key = text(raw.key);
  if (!UUID.test(groupId) || !realDate(due) || !KEY.test(key)) return bad;
  return { ok: true, value: { groupId, due, key } };
}
export function parseVoidInvoiceForm(raw: Raw): Parsed<{ groupId: string; invoiceId: string; reason: string }> {
  const groupId = text(raw.groupId);
  const invoiceId = text(raw.invoiceId);
  const reason = text(raw.reason);
  if (!UUID.test(groupId) || !UUID.test(invoiceId) || reason.length < 1 || reason.length > 200) return bad;
  return { ok: true, value: { groupId, invoiceId, reason } };
}
export function parsePaidInvoiceForm(raw: Raw): Parsed<{ groupId: string; invoiceId: string; method: string; reference: string | null }> {
  const groupId = text(raw.groupId);
  const invoiceId = text(raw.invoiceId);
  const method = text(raw.method);
  const reference = text(raw.reference);
  if (!UUID.test(groupId) || !UUID.test(invoiceId) || !(PAY_METHODS as readonly string[]).includes(method) || reference.length > 60)
    return bad;
  return { ok: true, value: { groupId, invoiceId, method, reference: reference || null } };
}

export function parseRoomingRemoveForm(raw: Raw): Parsed<{ groupId: string; entryId: string }> {
  const groupId = text(raw.groupId);
  const entryId = text(raw.entryId);
  if (!UUID.test(groupId) || !UUID.test(entryId)) return bad;
  return { ok: true, value: { groupId, entryId } };
}

// ---- reading what the database returns ---------------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);

export type GroupStatus = "open" | "released" | "cancelled";
const status = (v: unknown): GroupStatus => (v === "released" || v === "cancelled" ? v : "open");
export const GROUP_STATUS_LABEL: Record<GroupStatus, string> = { open: "Rooms held", released: "Released", cancelled: "Cancelled" };

export type GroupRow = {
  id: string;
  name: string;
  company: string | null;
  contactName: string;
  arrival: string;
  departure: string;
  release: string;
  status: GroupStatus;
  roomsTotal: number;
  roomsHeld: number;
  rooming: number;
};

export function parseGroupList(data: unknown): GroupRow[] {
  return arr(data)
    .map((g) => ({
      id: str(g.id),
      name: str(g.name),
      company: strOrNull(g.company),
      contactName: str(g.contact_name),
      arrival: str(g.arrival_date),
      departure: str(g.departure_date),
      release: str(g.release_date),
      status: status(g.status),
      roomsTotal: num(g.rooms_total),
      roomsHeld: num(g.rooms_held),
      rooming: num(g.rooming_count),
    }))
    .filter((g) => g.id !== "");
}

export type GroupDetail = {
  id: string;
  propertyId: string;
  name: string;
  company: string | null;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  arrival: string;
  departure: string;
  release: string;
  status: GroupStatus;
  notes: string | null;
  rooms: { roomTypeId: string; name: string; held: number; used: number; released: number }[];
  rooming: {
    id: string;
    guest: string;
    roomTypeName: string | null;
    notes: string | null;
    bookingId: string | null;
    bookingReference: string | null;
  }[];
};

export function parseGroupDetail(data: unknown): GroupDetail | null {
  const d = rec(data);
  if (!d || str(d.id) === "") return null;
  return {
    id: str(d.id),
    propertyId: str(d.property_id),
    name: str(d.name),
    company: strOrNull(d.company),
    contactName: str(d.contact_name),
    contactPhone: strOrNull(d.contact_phone),
    contactEmail: strOrNull(d.contact_email),
    arrival: str(d.arrival_date),
    departure: str(d.departure_date),
    release: str(d.release_date),
    status: status(d.status),
    notes: strOrNull(d.notes),
    rooms: arr(d.rooms).map((r) => ({
      roomTypeId: str(r.room_type_id),
      name: str(r.room_type_name),
      held: num(r.held),
      used: num(r.used),
      released: num(r.released),
    })),
    rooming: arr(d.rooming).map((r) => ({
      id: str(r.id),
      guest: str(r.guest_name),
      roomTypeName: strOrNull(r.room_type_name),
      notes: strOrNull(r.notes),
      bookingId: strOrNull(r.reservation_id),
      bookingReference: strOrNull(r.booking_reference),
    })),
  };
}

/** "3 Standard, 1 Deluxe" for the rooms still held; empty text when none. */
export function heldSummary(rooms: GroupDetail["rooms"]): string {
  return rooms
    .filter((r) => r.held > 0)
    .map((r) => `${r.held} ${r.name}`)
    .join(", ");
}

export type StatementBooking = {
  entryId: string;
  guest: string;
  bookingId: string;
  reference: string;
  status: string;
  paymentStatus: string;
  arrival: string;
  departure: string;
  totalMinor: number | null;
  extrasMinor: number | null;
  extrasPaidMinor: number | null;
};
export type GroupStatement = {
  moneyVisible: boolean;
  currency: string;
  bookings: StatementBooking[];
  namesWithoutBooking: number;
  totalMinor: number | null;
  extrasMinor: number | null;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

export function parseGroupStatement(data: unknown): GroupStatement | null {
  const d = rec(data);
  if (!d) return null;
  return {
    moneyVisible: d.money_visible === true,
    currency: str(d.currency) || "NGN",
    namesWithoutBooking: num(d.names_without_booking),
    totalMinor: numOrNull(d.total_minor),
    extrasMinor: numOrNull(d.extras_minor),
    bookings: arr(d.bookings).map((b) => ({
      entryId: str(b.entry_id),
      guest: str(b.guest_name),
      bookingId: str(b.reservation_id),
      reference: str(b.booking_reference),
      status: str(b.reservation_status),
      paymentStatus: str(b.payment_status),
      arrival: str(b.arrival_date),
      departure: str(b.departure_date),
      totalMinor: numOrNull(b.total_minor),
      extrasMinor: numOrNull(b.extras_minor),
      extrasPaidMinor: numOrNull(b.extras_paid_minor),
    })),
  };
}

export type GroupInvoice = {
  id: string;
  number: string;
  status: "issued" | "paid" | "void";
  billTo: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  dueDate: string;
  issuedAt: string;
  paidAt: string | null;
  paidMethod: string | null;
  paidReference: string | null;
  voidReason: string | null;
  lines: { reference: string; guest: string; arrival: string; departure: string; netMinor: number; taxMinor: number; totalMinor: number }[];
};
export function parseGroupInvoices(data: unknown): GroupInvoice[] {
  return arr(data)
    .map((i) => ({
      id: str(i.id),
      number: str(i.invoice_number),
      status: (i.status === "paid" || i.status === "void" ? i.status : "issued") as GroupInvoice["status"],
      billTo: str(i.bill_to),
      currency: str(i.currency) || "NGN",
      subtotalMinor: num(i.subtotal_minor),
      taxMinor: num(i.tax_minor),
      totalMinor: num(i.total_minor),
      dueDate: str(i.due_date),
      issuedAt: str(i.issued_at),
      paidAt: strOrNull(i.paid_at),
      paidMethod: strOrNull(i.paid_method),
      paidReference: strOrNull(i.paid_reference),
      voidReason: strOrNull(i.void_reason),
      lines: arr(i.lines).map((l) => ({
        reference: str(l.booking_reference),
        guest: str(l.guest_name),
        arrival: str(l.arrival_date),
        departure: str(l.departure_date),
        netMinor: num(l.net_minor),
        taxMinor: num(l.tax_minor),
        totalMinor: num(l.line_total_minor),
      })),
    }))
    .filter((i) => i.id !== "");
}
