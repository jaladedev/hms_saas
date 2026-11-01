/**
 * Folio screens (migration 027): the extras charged during a stay (minibar, laundry, a late check-out) and the money
 * taken for them, shown as a Folio section on `/app/reservations/[id]`. Pure functions, so they can be tested. The
 * database decides who may do what and checks every figure again; these helpers only decide what to show, which
 * buttons are worth offering, and how to word a refusal.
 *
 * The folio is a statement kept BESIDE the reservation's money, not inside it: nothing here touches the booking's
 * total, invoice, payments or refunds.
 */
import { minorToInput, parseAmountToMinor } from "./money-input";
import type { ErrorCode } from "./refunds";
import { isPaymentMethod, parseIsoDate } from "./reservations";

/** What a charge was for, in the words front desk uses. The first value is what the database stores. */
export const FOLIO_CATEGORIES = [
  { value: "minibar", label: "Minibar" },
  { value: "food_beverage", label: "Food and drink" },
  { value: "laundry", label: "Laundry" },
  { value: "late_checkout", label: "Late check-out" },
  { value: "phone", label: "Phone calls" },
  { value: "damage", label: "Damage or loss" },
  { value: "other", label: "Something else" },
] as const;
export type FolioCategory = (typeof FOLIO_CATEGORIES)[number]["value"];
export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(FOLIO_CATEGORIES.map((c) => [c.value, c.label]));
export const isFolioCategory = (v: string): v is FolioCategory => FOLIO_CATEGORIES.some((c) => c.value === v);

/** The database's limits (027), repeated here so a form is refused before it is sent. The database still checks them. */
export const FOLIO_LIMITS = { quantityMax: 1000, unitMaxMinor: 1_000_000_000, descriptionMax: 200, reasonMax: 200, referenceMax: 100, noteMax: 500 } as const;

export type ChargeRow = {
  id: string;
  reservation_room_id: string | null;
  category: string;
  description: string;
  quantity: number;
  unit_amount_minor: number;
  tax_minor: number;
  total_minor: number;
  charge_date: string;
  status: string;
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
};
export type PaymentRow = {
  id: string;
  payment_method: string;
  provider_reference: string | null;
  internal_reference: string;
  amount_minor: number;
  payment_status: string;
  note: string | null;
  received_at: string;
  reversed_at: string | null;
  reverse_reason: string | null;
};
/** Every column the screen reads. Who posted or voided is not shown, so those columns are not read. */
export const CHARGE_COLUMNS =
  "id, reservation_room_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, charge_date, status, created_at, voided_at, void_reason";
export const PAYMENT_COLUMNS =
  "id, payment_method, provider_reference, internal_reference, amount_minor, payment_status, note, received_at, reversed_at, reverse_reason";

/** The answer of `folio_balance(reservation)`: posted charges (tax included) less succeeded folio payments. */
export type FolioBalance = {
  currency: string;
  charge_count: number;
  charges_minor: number;
  tax_minor: number;
  paid_minor: number;
  balance_minor: number;
};

/** A guest who has not arrived has no folio; one who is in the house or has just left does. */
export const folioIsOpen = (reservationStatus: string) => reservationStatus === "checked_in" || reservationStatus === "checked_out";

/** Posted charges in the order they happened; voided ones, most recently voided first. */
export function splitCharges(rows: ChargeRow[]): { posted: ChargeRow[]; voided: ChargeRow[] } {
  const posted = rows.filter((c) => c.status === "posted").sort((a, b) => a.charge_date.localeCompare(b.charge_date) || a.created_at.localeCompare(b.created_at));
  const voided = rows.filter((c) => c.status === "voided").sort((a, b) => (b.voided_at ?? "").localeCompare(a.voided_at ?? ""));
  return { posted, voided };
}

/** Money received in the order it came in; reversed payments, most recently reversed first. */
export function splitPayments(rows: PaymentRow[]): { received: PaymentRow[]; reversed: PaymentRow[] } {
  const received = rows.filter((p) => p.payment_status === "succeeded").sort((a, b) => a.received_at.localeCompare(b.received_at));
  const reversed = rows.filter((p) => p.payment_status === "reversed").sort((a, b) => (b.reversed_at ?? "").localeCompare(a.reversed_at ?? ""));
  return { received, reversed };
}

export type FolioViewer = {
  /** folio.charge: post and void charges. */
  charge: boolean;
  /** payment.record: take money for the extras. */
  record: boolean;
  /** refund.approve: undo a recorded folio payment, so the person who took the money is not the one who reverses it. */
  reverse: boolean;
};

export type FolioActions = {
  post: boolean;
  /** Money can be taken only while something is owed; the database refuses more than the balance. */
  recordPayment: boolean;
  /** What a payment may not exceed: the balance. */
  payableCeilingMinor: number;
  /** A charge can be voided unless the money already collected would then be more than the charges that remain. */
  voidCharge: (c: Pick<ChargeRow, "status" | "total_minor">) => boolean;
  /** A posted charge the viewer could void, were it not for money collected against it: the screen says why instead. */
  voidBlockedByPayment: (c: Pick<ChargeRow, "status" | "total_minor">) => boolean;
  reversePayment: (p: Pick<PaymentRow, "payment_status">) => boolean;
};

/** Which folio controls to show. This only hides buttons the database would refuse: it checks again on every call. */
export function folioActions(reservationStatus: string, balance: FolioBalance, viewer: FolioViewer): FolioActions {
  const open = folioIsOpen(reservationStatus);
  const owing = Math.max(balance.balance_minor, 0);
  const wouldOverpay = (c: Pick<ChargeRow, "total_minor">) => balance.paid_minor > balance.charges_minor - c.total_minor;
  return {
    post: viewer.charge && open,
    recordPayment: viewer.record && open && owing > 0,
    payableCeilingMinor: owing,
    voidCharge: (c) => viewer.charge && open && c.status === "posted" && !wouldOverpay(c),
    voidBlockedByPayment: (c) => viewer.charge && open && c.status === "posted" && wouldOverpay(c),
    reversePayment: (p) => viewer.reverse && open && p.payment_status === "succeeded",
  };
}

/** What a guest still owes for extras, never below zero. */
export const owingMinor = (balance: FolioBalance | null) => (balance ? Math.max(balance.balance_minor, 0) : 0);

/** The warning shown beside the Check out button. Check-out is never blocked by an owing folio; this only says so. */
export function checkoutNote(owing: number, money: (minor: number) => string): string | null {
  return owing > 0 ? `${money(owing)} is still owed for extras. You can still check the guest out; the balance stays on the folio.` : null;
}

/** The line at the top of the folio when money is owed, worded for a guest who is still here or has already left. */
export function owingNotice(reservationStatus: string, owing: number, money: (minor: number) => string): string | null {
  if (owing <= 0) return null;
  if (reservationStatus === "checked_out") return `The guest has checked out with ${money(owing)} still owed for extras.`;
  return `${money(owing)} is owed for extras so far. It does not stop check-out.`;
}

// ---- forms --------------------------------------------------------------------------------

type Raw = Record<string, FormDataEntryValue | undefined>;
const text = (v: FormDataEntryValue | undefined) => (typeof v === "string" ? v : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChargeInput = {
  category: FolioCategory;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  /** null means today, in the hotel's own time zone (the database decides what that is). */
  date: string | null;
  roomId: string | null;
};
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

/**
 * Reads the "add a charge" form. It checks the shape only (a known category, whole numbers, a price in range, a real
 * date); whether the date falls between arrival and today, and whether the room is on the booking, is the database's call.
 */
export function parseChargeForm(raw: Raw): Parsed<ChargeInput> {
  const category = text(raw.category);
  if (!isFolioCategory(category)) return { ok: false, code: "fo_category" };
  const description = text(raw.description).trim();
  if (description.length < 1 || description.length > FOLIO_LIMITS.descriptionMax) return { ok: false, code: "fo_description" };
  const q = text(raw.quantity).trim();
  const quantity = /^\d{1,4}$/.test(q) ? Number(q) : 0;
  if (quantity < 1 || quantity > FOLIO_LIMITS.quantityMax) return { ok: false, code: "fo_quantity" };
  const unit = parseAmountToMinor(text(raw.amount));
  if (unit === null || unit > FOLIO_LIMITS.unitMaxMinor) return { ok: false, code: "fo_amount" };
  const dateText = text(raw.date).trim();
  const date = dateText === "" ? null : parseIsoDate(dateText);
  if (dateText !== "" && date === null) return { ok: false, code: "fo_date" };
  const roomText = text(raw.reservationRoomId).trim();
  if (roomText !== "" && !UUID.test(roomText)) return { ok: false, code: "fo_room" };
  return { ok: true, value: { category, description, quantity, unitAmountMinor: unit, date, roomId: roomText === "" ? null : roomText } };
}

export type PaymentInput = { amountMinor: number; method: string; reference: string | null; note: string | null };

/** Reads the "record a payment for extras" form. The cap (never more than the balance) is the database's call. */
export function parsePaymentForm(raw: Raw): Parsed<PaymentInput> {
  const amount = parseAmountToMinor(text(raw.amount));
  if (amount === null) return { ok: false, code: "fo_amount" };
  const method = text(raw.method);
  if (!isPaymentMethod(method)) return { ok: false, code: "fo_method" };
  const reference = text(raw.reference).trim();
  const note = text(raw.note).trim();
  if (reference.length > FOLIO_LIMITS.referenceMax || note.length > FOLIO_LIMITS.noteMax) return { ok: false, code: "fo_too_long" };
  return { ok: true, value: { amountMinor: amount, method, reference: reference || null, note: note || null } };
}

/** The reason that voiding a charge or reversing a payment needs: required, and short enough for the record. */
export function parseReason(value: FormDataEntryValue | undefined): Parsed<string> {
  const reason = text(value).trim();
  return reason.length < 1 || reason.length > FOLIO_LIMITS.reasonMax ? { ok: false, code: "fo_reason" } : { ok: true, value: reason };
}

/** The amount to prefill a payment with: everything owed, since the usual case is the guest settling up. */
export const prefillPayment = (owing: number) => (owing > 0 ? minorToInput(owing) : "");

// ---- results ------------------------------------------------------------------------------

/**
 * Turns a database refusal from one of the five folio functions into a code. Total: those functions have a small,
 * known vocabulary, so the shared classifier (which words FORBIDDEN and INVALID_STATE for reservations) is not used.
 * `n` carries the amount still outstanding when a payment was too big.
 */
export function classifyFolioError(message: string): { code: ErrorCode; n?: number } {
  const over = /OVERPAYMENT outstanding (\d+)/.exec(message);
  if (over) return { code: "fo_overpay", n: Number(over[1]) };
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return { code: "fo_duplicate" };
  if (/INVALID_STATE: folio paid/.test(message)) return { code: "fo_paid" };
  if (/INVALID_STATE/.test(message)) return { code: "fo_not_open" };
  if (/POLICY_VIOLATION: category/.test(message)) return { code: "fo_category" };
  if (/POLICY_VIOLATION: description/.test(message)) return { code: "fo_description" };
  if (/POLICY_VIOLATION: quantity/.test(message)) return { code: "fo_quantity" };
  if (/POLICY_VIOLATION: amount/.test(message)) return { code: "fo_amount" };
  if (/POLICY_VIOLATION: date/.test(message)) return { code: "fo_date" };
  if (/POLICY_VIOLATION: room/.test(message)) return { code: "fo_room" };
  if (/POLICY_VIOLATION: reason/.test(message)) return { code: "fo_reason" };
  if (/POLICY_VIOLATION: payment method/.test(message)) return { code: "fo_method" };
  if (/POLICY_VIOLATION: too long/.test(message)) return { code: "fo_too_long" };
  if (/NOT_FOUND|FORBIDDEN/.test(message)) return { code: "fo_not_found" };
  return { code: "fo_unknown" };
}

/** Success codes the folio actions send back (worded in `OK_MESSAGES`). */
export const FOLIO_OK_CODES = ["fo_posted", "fo_voided", "fo_payment", "fo_reversed"] as const;

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * True when the last action came from the folio, so the page shows its result inside the Folio section (where the
 * redirect lands) rather than at the top, out of sight. Every folio code starts with "fo_".
 */
export function isFolioResult(search: Search): boolean {
  return /^fo_/.test(one(search.ok) ?? "") || /^fo_/.test(one(search.err) ?? "");
}
