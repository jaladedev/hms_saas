/**
 * Group bookings, step one (migration 150): reading what the database returns, checking what a form sends, and the words the screens use.
 * Pure, so it is tested without a server. The database checks everything again; nothing here is trusted for permission.
 */
import { parseAmountToMinor } from "./money-input";

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
  credit_short: "The company does not have that much credit. Check the balance, or record the money it paid first.",
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
  company_invalid:
    "Check the company details: a name and billing contact (up to 80 characters each), credit days from 0 to 90, and an agreed discount from 0 to 50 percent.",
  company_taken: "A company with that name already exists at this hotel.",
  company_forbidden: "Only an owner or general manager can create or change company accounts.",
  group_company_missing: "That company is archived or not found.",
  group_no_rate: "Attach a company with an agreed discount above 0 first.",
  group_pay_invalid: "Check the payment: an amount (or shares) above 0, how it was paid, and a reference of up to 60 characters.",
  group_pay_exceeds: "That is more than the group still owes. Nothing was recorded.",
  group_pay_overpay: "A share is more than that booking still owes. Nothing was recorded.",
  group_pay_alloc:
    "The shares do not add up, or a share is for a booking that is not linked to this group or cannot take payment. Nothing was recorded.",
  group_pay_reversed: "Every payment on that company payment is already reversed.",
  group_pay_refunds: "A payment on it has a refund, so it cannot be reversed here.",
  group_credit_limit:
    "That would take the company above its credit limit. Collect payment on its open invoices first, or ask an owner or general manager to raise the limit.",
  company_rate_invalid: "Check the rate: pick a room type, a fixed nightly price in naira, or a percent from 0.01 to 50.",
  group_limit: "A rooming list holds at most 200 names.",
  group_reused: "That form was already sent with other details. Reload the page and try again.",
  group_failed: "That did not work. Reload the page and try again.",
} as const;
export type GroupErrorCode = keyof typeof GROUP_ERROR_MESSAGES;

export const GROUP_OK_MESSAGES = {
  credit_deposited: "Money added to the company's credit balance.",
  credit_applied: "Paid from the company's credit balance. It is split across the bookings like any company payment.",
  credit_withdrawn: "Credit paid back or written off.",
  group_created: "Group created. The rooms are held and cannot be sold until the release date.",
  group_updated: "Group saved.",
  group_cancelled: "Group cancelled. The held rooms are free again.",
  group_unit_used: "One held room was freed so you can book it for a guest. Make that booking now from Reservations.",
  group_rooming_added: "Name added to the rooming list.",
  group_rooming_removed: "Name removed from the rooming list.",
  group_invoice_issued: "Invoice issued to the company.",
  group_invoice_voided: "Invoice voided. Its bookings can be invoiced again.",
  group_invoice_paid: "Marked as paid by the company. The bookings' own payment status is not changed.",
  company_created: "Company account created.",
  company_updated: "Company account saved. Discounts already applied to bookings are not changed.",
  group_company_set: "Company changed for this group.",
  group_rate_applied: "Company rate applied.",
  group_payment_recorded: "Company payment recorded and split across the bookings.",
  group_payment_reversed: "Company payment reversed on every booking.",
  company_rate_saved: "Room type rate saved. Bookings that already have a discount are not changed.",
  company_rate_removed: "Room type rate removed.",
  company_auto_on: "Company rate will now be applied when a booking is linked to the company's groups.",
  company_reminders_on: "Overdue invoice reminders are on for this company.",
  company_reminders_off: "Overdue invoice reminders are off for this company.",
  company_auto_off: "Company rate is no longer applied automatically.",
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
  if (/POLICY_VIOLATION: name taken/.test(message)) return "company_taken";
  if (/POLICY_VIOLATION: company/.test(message)) return "group_company_missing";
  if (/POLICY_VIOLATION: no company rate/.test(message)) return "group_no_rate";
  if (/POLICY_VIOLATION: credit balance/.test(message)) return "credit_short";
  if (/POLICY_VIOLATION: exceeds outstanding/.test(message)) return "group_pay_exceeds";
  if (/POLICY_VIOLATION: OVERPAYMENT/.test(message)) return "group_pay_overpay";
  if (/POLICY_VIOLATION: allocation/.test(message)) return "group_pay_alloc";
  if (/POLICY_VIOLATION: (amount|method)/.test(message)) return "group_pay_invalid";
  if (/INVALID_STATE: reversed/.test(message)) return "group_pay_reversed";
  if (/INVALID_STATE: payment has refunds/.test(message)) return "group_pay_refunds";
  if (/POLICY_VIOLATION: credit limit/.test(message)) return "group_credit_limit";
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

const num2 = (v: string): number | null => (/^\d{1,2}(\.\d{1,2})?$/.test(v) ? Number(v) : null);

export type CompanyForm = {
  propertyId: string;
  name: string;
  contact: string;
  email: string | null;
  phone: string | null;
  creditDays: number;
  percent: number;
  notes: string | null;
  creditLimitMinor: number | null;
};
function companyFields(raw: Raw): Omit<CompanyForm, "propertyId" | "name"> | null {
  const contact = text(raw.contact);
  const email = text(raw.email);
  const phone = text(raw.phone);
  const notes = text(raw.notes);
  const days = text(raw.creditDays) || "0";
  const pct = num2(text(raw.percent) || "0");
  if (contact.length < 1 || contact.length > 80 || notes.length > 500) return null;
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+$/.test(email))) return null;
  if (phone && (phone.length < 3 || phone.length > 30)) return null;
  if (!/^\d{1,2}$/.test(days) || Number(days) > 90) return null;
  if (pct === null || pct > 50) return null;
  const limitText = text(raw.creditLimit);
  const limit = limitText === "" ? null : parseAmountToMinor(limitText);
  if (limitText !== "" && limit === null) return null;
  return {
    contact,
    email: email || null,
    phone: phone || null,
    creditDays: Number(days),
    percent: pct,
    notes: notes || null,
    creditLimitMinor: limit,
  };
}
export function parseCompanyCreateForm(raw: Raw): { ok: true; value: CompanyForm } | { ok: false; code: GroupErrorCode } {
  const propertyId = text(raw.propertyId);
  const name = text(raw.name);
  const f = companyFields(raw);
  if (!UUID.test(propertyId) || name.length < 1 || name.length > 80 || !f) return { ok: false, code: "company_invalid" };
  return { ok: true, value: { propertyId, name, ...f } };
}
export function parseCompanyUpdateForm(
  raw: Raw,
):
  | { ok: true; value: Omit<CompanyForm, "propertyId" | "name"> & { companyId: string; status: string } }
  | { ok: false; code: GroupErrorCode } {
  const companyId = text(raw.companyId);
  const status = text(raw.status) || "active";
  const f = companyFields(raw);
  if (!UUID.test(companyId) || !f || (status !== "active" && status !== "archived")) return { ok: false, code: "company_invalid" };
  return { ok: true, value: { companyId, status, ...f } };
}
export function parseCompanyRateForm(
  raw: Raw,
):
  | { ok: true; value: { companyId: string; roomTypeId: string; mode: "fixed" | "percent"; value: number } }
  | { ok: false; code: GroupErrorCode } {
  const companyId = text(raw.companyId);
  const roomTypeId = text(raw.roomTypeId);
  const mode = text(raw.mode);
  const v = text(raw.value);
  const badRate = { ok: false, code: "company_rate_invalid" } as const;
  if (!UUID.test(companyId) || !UUID.test(roomTypeId) || (mode !== "fixed" && mode !== "percent")) return badRate;
  if (mode === "fixed") {
    const minor = parseAmountToMinor(v);
    if (minor === null) return badRate;
    return { ok: true, value: { companyId, roomTypeId, mode, value: minor } };
  }
  const pct = num2(v);
  if (pct === null || pct <= 0 || pct > 50) return badRate;
  return { ok: true, value: { companyId, roomTypeId, mode, value: pct } };
}
export function parseCompanyRateRemoveForm(raw: Raw): Parsed<{ companyId: string; roomTypeId: string }> {
  const companyId = text(raw.companyId);
  const roomTypeId = text(raw.roomTypeId);
  if (!UUID.test(companyId) || !UUID.test(roomTypeId)) return bad;
  return { ok: true, value: { companyId, roomTypeId } };
}

export function parseAutoRateForm(raw: Raw): Parsed<{ companyId: string; on: boolean }> {
  const companyId = text(raw.companyId);
  if (!UUID.test(companyId) || (raw.on !== "true" && raw.on !== "false")) return bad;
  return { ok: true, value: { companyId, on: raw.on === "true" } };
}

export function parseSetCompanyForm(raw: Raw): Parsed<{ groupId: string; companyId: string | null }> {
  const groupId = text(raw.groupId);
  const companyId = text(raw.companyId);
  if (!UUID.test(groupId) || (companyId && !UUID.test(companyId))) return bad;
  return { ok: true, value: { groupId, companyId: companyId || null } };
}
export function parseApplyRateForm(raw: Raw): Parsed<{ groupId: string; key: string }> {
  const groupId = text(raw.groupId);
  const key = text(raw.key);
  if (!UUID.test(groupId) || !KEY.test(key)) return bad;
  return { ok: true, value: { groupId, key } };
}

export type GroupPaymentForm = {
  groupId: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  note: string | null;
  allocations: { reservation_id: string; amount_minor: number }[] | null;
  key: string;
};
/**
 * Shares come as fields named share_<booking id> (in naira). If any share is filled in, those shares are the split and their sum is the
 * amount; otherwise the amount field is used and the money fills the bookings' outstanding amounts in arrival order.
 */
export function parseGroupPaymentForm(raw: Raw): Parsed<GroupPaymentForm> {
  const groupId = text(raw.groupId);
  const method = text(raw.method);
  const reference = text(raw.reference);
  const note = text(raw.note);
  const key = text(raw.key);
  const bad2 = { ok: false, code: "group_pay_invalid" } as const;
  if (
    !UUID.test(groupId) ||
    !KEY.test(key) ||
    !(PAY_METHODS as readonly string[]).includes(method) ||
    reference.length > 60 ||
    note.length > 200
  )
    return bad2;
  const shares: { reservation_id: string; amount_minor: number }[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("share_")) continue;
    const id = k.slice(6);
    const t = text(v);
    if (t === "") continue;
    const minor = parseAmountToMinor(t);
    if (!UUID.test(id) || minor === null) return bad2;
    shares.push({ reservation_id: id, amount_minor: minor });
  }
  if (shares.length > 50) return bad2;
  const amount = shares.length > 0 ? shares.reduce((n, x) => n + x.amount_minor, 0) : parseAmountToMinor(text(raw.amount));
  if (amount === null || amount <= 0 || amount > 1_000_000_000_000) return bad2;
  return {
    ok: true,
    value: {
      groupId,
      amountMinor: amount,
      method,
      reference: reference || null,
      note: note || null,
      allocations: shares.length ? shares : null,
      key,
    },
  };
}

export function parseReverseGroupPaymentForm(raw: Raw): Parsed<{ groupId: string; paymentId: string; reason: string; key: string }> {
  const groupId = text(raw.groupId);
  const paymentId = text(raw.paymentId);
  const reason = text(raw.reason);
  const key = text(raw.key);
  if (!UUID.test(groupId) || !UUID.test(paymentId) || !KEY.test(key)) return bad;
  if (reason.length < 1 || reason.length > 200) return { ok: false, code: "group_reason" };
  return { ok: true, value: { groupId, paymentId, reason, key } };
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
  companyId: string | null;
  companyAccount: string | null;
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
    companyId: strOrNull(d.company_id),
    companyAccount: strOrNull(d.company_account),
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
  heldMinor: number | null;
  outstandingMinor: number | null;
};
export type GroupStatement = {
  moneyVisible: boolean;
  currency: string;
  bookings: StatementBooking[];
  namesWithoutBooking: number;
  totalMinor: number | null;
  extrasMinor: number | null;
  heldMinor: number | null;
  outstandingMinor: number | null;
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
    heldMinor: numOrNull(d.held_minor),
    outstandingMinor: numOrNull(d.outstanding_minor),
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
      heldMinor: numOrNull(b.held_minor),
      outstandingMinor: numOrNull(b.outstanding_minor),
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

export type CompanyAccount = {
  id: string;
  name: string;
  contact: string;
  email: string | null;
  phone: string | null;
  creditDays: number;
  percent: number;
  status: "active" | "archived";
  notes: string | null;
  groups: number;
  creditLimitMinor: number | null;
  exposureMinor: number;
  overdueMinor: number;
  autoApplyRate: boolean;
  remindOverdue: boolean;
  rates: { roomTypeId: string; roomTypeName: string; mode: "fixed" | "percent"; nightlyRateMinor: number | null; percent: number | null }[];
};
export function parseCompanies(data: unknown): CompanyAccount[] {
  return arr(data)
    .map((c) => ({
      id: str(c.id),
      name: str(c.name),
      contact: str(c.billing_contact),
      email: strOrNull(c.billing_email),
      phone: strOrNull(c.billing_phone),
      creditDays: num(c.credit_days),
      percent: typeof c.discount_percent === "number" ? c.discount_percent : Number(c.discount_percent) || 0,
      status: (c.status === "archived" ? "archived" : "active") as CompanyAccount["status"],
      notes: strOrNull(c.notes),
      groups: num(c.groups),
      creditLimitMinor: c.credit_limit_minor === null || c.credit_limit_minor === undefined ? null : num(c.credit_limit_minor),
      exposureMinor: num(c.exposure_minor),
      overdueMinor: num(c.overdue_minor),
      autoApplyRate: c.auto_apply_rate === true,
      remindOverdue: c.remind_overdue === true,
      rates: arr(c.rates).map((r) => ({
        roomTypeId: str(r.room_type_id),
        roomTypeName: str(r.room_type_name),
        mode: (r.mode === "percent" ? "percent" : "fixed") as "fixed" | "percent",
        nightlyRateMinor: r.nightly_rate_minor === null || r.nightly_rate_minor === undefined ? null : num(r.nightly_rate_minor),
        percent: r.percent === null || r.percent === undefined ? null : Number(r.percent) || 0,
      })),
    }))
    .filter((c) => c.id !== "");
}

/** Today plus the company's credit days, as YYYY-MM-DD, for suggesting an invoice due date. */
export function suggestedDueDate(today: string, creditDays: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.min(90, creditDays)));
  return d.toISOString().slice(0, 10);
}

export type GroupPayment = {
  id: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  note: string | null;
  receivedAt: string;
  state: "recorded" | "partly_reversed" | "reversed";
  lines: { reservationId: string; reference: string; guest: string; amountMinor: number; paymentStatus: string }[];
};
export function parseGroupPayments(data: unknown): GroupPayment[] {
  return arr(data)
    .map((p) => ({
      id: str(p.id),
      amountMinor: num(p.amount_minor),
      method: str(p.method),
      reference: strOrNull(p.reference),
      note: strOrNull(p.note),
      receivedAt: str(p.received_at),
      state: (p.state === "reversed" || p.state === "partly_reversed" ? p.state : "recorded") as GroupPayment["state"],
      lines: arr(p.lines).map((l) => ({
        reservationId: str(l.reservation_id),
        reference: str(l.booking_reference),
        guest: str(l.guest_name),
        amountMinor: num(l.amount_minor),
        paymentStatus: str(l.payment_status),
      })),
    }))
    .filter((p) => p.id !== "");
}

export type OverdueInvoice = {
  invoiceId: string;
  number: string;
  groupId: string;
  groupName: string;
  billTo: string;
  currency: string;
  totalMinor: number;
  dueDate: string;
  daysOverdue: number;
  reminder: ReminderInfo | null;
};
export function parseOverdue(data: unknown): OverdueInvoice[] {
  return arr(data)
    .map((i) => ({
      invoiceId: str(i.invoice_id),
      number: str(i.invoice_number),
      groupId: str(i.group_id),
      groupName: str(i.group_name),
      billTo: str(i.bill_to),
      currency: str(i.currency) || "NGN",
      totalMinor: num(i.total_minor),
      dueDate: str(i.due_date),
      daysOverdue: num(i.days_overdue),
      reminder: parseReminderInfo(i.reminder_info),
    }))
    .filter((i) => i.invoiceId !== "");
}

export type ReminderOutcome = "queued" | "sending" | "sent" | "closed" | "failed";
export const REMINDER_OUTCOME_LABEL: Record<ReminderOutcome, string> = {
  queued: "Waiting to be sent",
  sending: "Being sent",
  sent: "Sent",
  closed: "Not sent: the invoice was paid or voided first",
  failed: "Could not be delivered",
};
export type ReminderInfo = {
  remindersOn: boolean;
  hasEmail: boolean;
  nextReminderDate: string | null;
  reminders: { no: number; outcome: ReminderOutcome; queuedAt: string; sentAt: string | null }[];
};

/** The reminder status of one group invoice (migration 167). Null when the data does not look right. */
export function parseReminderInfo(data: unknown): ReminderInfo | null {
  const d = rec(data);
  if (!d) return null;
  const reminders: ReminderInfo["reminders"] = [];
  for (const r of arr(d.reminders)) {
    const outcome = (["queued", "sending", "sent", "closed", "failed"] as const).find((o) => o === r.outcome);
    if (!outcome) continue;
    reminders.push({ no: num(r.no), outcome, queuedAt: str(r.queued_at), sentAt: typeof r.sent_at === "string" ? r.sent_at : null });
  }
  return {
    remindersOn: d.reminders_on === true,
    hasEmail: d.has_email === true,
    nextReminderDate: typeof d.next_reminder_date === "string" ? d.next_reminder_date : null,
    reminders,
  };
}

/** One line for the overdue list: "1 sent, next 21 Nov". The caller formats the date. */
export function reminderSummary(info: ReminderInfo | null, date: (iso: string) => string): string {
  if (!info) return "";
  if (!info.remindersOn) return "Reminders are off for this company";
  if (!info.hasEmail) return "No email on the invoice, so none are sent";
  const count = (o: ReminderOutcome[]) => info.reminders.filter((r) => o.includes(r.outcome)).length;
  const parts: string[] = [];
  if (count(["sent"]) > 0) parts.push(`${count(["sent"])} sent`);
  if (count(["queued", "sending"]) > 0) parts.push(`${count(["queued", "sending"])} on the way`);
  if (count(["failed"]) > 0) parts.push(`${count(["failed"])} not delivered`);
  if (parts.length === 0) parts.push("none yet");
  if (info.nextReminderDate) parts.push(`next ${date(info.nextReminderDate)}`);
  return parts.join(", ");
}
