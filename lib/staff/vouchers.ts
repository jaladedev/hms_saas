import { parseAmountToMinor } from "./money-input";

/**
 * Gift and discount vouchers (migration 161): what a form sends is checked here so a typo is refused before it reaches the database, and
 * the database's own refusals are turned into the codes the page words. The database still decides everything that matters (permission,
 * the flag, the voucher's balance and expiry, the state of the booking); nothing here is a rule, only a courtesy.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MIN_VOUCHER_MINOR = 10000;
export const MAX_VOUCHER_MINOR = 100000000;

export type VoucherKind = "gift" | "discount";
export const VOUCHER_KINDS: { kind: VoucherKind; label: string; help: string }[] = [
  { kind: "gift", label: "Gift voucher", help: "Stored value. What is not spent on one booking stays for the next." },
  { kind: "discount", label: "Discount voucher", help: "One use. It takes its value off one booking and is then used up." },
];

export type IssueForm = { propertyId: string; kind: VoucherKind; amountMinor: number; expiresOn: string | null; note: string | null };

/** The issue form: a kind, an amount in naira (100 to 1,000,000), an optional expiry date and an optional note of up to 200 characters. */
export function parseIssueForm(raw: Record<string, unknown>): { ok: true; value: IssueForm } | { ok: false; code: "voucher_invalid" } {
  const propertyId = String(raw.propertyId ?? "");
  const kind = String(raw.kind ?? "");
  const amount = parseAmountToMinor(String(raw.amount ?? ""));
  const expires = String(raw.expiresOn ?? "").trim();
  const note = String(raw.note ?? "").trim();
  if (
    !UUID.test(propertyId) ||
    (kind !== "gift" && kind !== "discount") ||
    amount === null ||
    amount < MIN_VOUCHER_MINOR ||
    amount > MAX_VOUCHER_MINOR ||
    (expires !== "" && (!DATE.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`)))) ||
    note.length > 200
  ) {
    return { ok: false, code: "voucher_invalid" };
  }
  return {
    ok: true,
    value: { propertyId, kind, amountMinor: amount, expiresOn: expires === "" ? null : expires, note: note === "" ? null : note },
  };
}

/** A code typed by staff: capitals, digits and dashes only, 6 to 24 characters. Spaces around it and lower case are forgiven. */
export function normaliseVoucherCode(input: unknown): string | null {
  const s = String(input ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z0-9-]{6,24}$/.test(s) ? s : null;
}

export function parseRedeemForm(
  raw: Record<string, unknown>,
): { ok: true; value: { reservationId: string; code: string } } | { ok: false; code: "voucher_invalid" } {
  const reservationId = String(raw.reservationId ?? "");
  const code = normaliseVoucherCode(raw.code);
  if (!UUID.test(reservationId) || code === null) return { ok: false, code: "voucher_invalid" };
  return { ok: true, value: { reservationId, code } };
}

export function parseVoidForm(
  raw: Record<string, unknown>,
): { ok: true; value: { voucherId: string; reason: string } } | { ok: false; code: "voucher_invalid" } {
  const voucherId = String(raw.voucherId ?? "");
  const reason = String(raw.reason ?? "").trim();
  if (!UUID.test(voucherId) || reason.length < 1 || reason.length > 200) return { ok: false, code: "voucher_invalid" };
  return { ok: true, value: { voucherId, reason } };
}

export type VoucherStatus = "active" | "used" | "expired" | "void";
export type VoucherRow = {
  id: string;
  code: string;
  kind: VoucherKind;
  face_value_minor: number;
  balance_minor: number;
  status: VoucherStatus;
  expires_on: string | null;
  note: string | null;
  created_at: string;
};

export const STATUS_LABEL: Record<VoucherStatus, string> = { active: "Active", used: "Used up", expired: "Expired", void: "Voided" };

export function parseVoucherList(data: unknown): VoucherRow[] {
  if (!Array.isArray(data)) return [];
  const out: VoucherRow[] = [];
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;
  for (const x of data) {
    if (!x || typeof x !== "object") continue;
    const d = x as Record<string, unknown>;
    const face = num(d.face_value_minor);
    const bal = num(d.balance_minor);
    if (typeof d.id !== "string" || typeof d.code !== "string" || (d.kind !== "gift" && d.kind !== "discount")) continue;
    if (face === null || bal === null || typeof d.created_at !== "string") continue;
    if (d.status !== "active" && d.status !== "used" && d.status !== "expired" && d.status !== "void") continue;
    out.push({
      id: d.id,
      code: d.code,
      kind: d.kind,
      face_value_minor: face,
      balance_minor: bal,
      status: d.status,
      expires_on: typeof d.expires_on === "string" ? d.expires_on : null,
      note: typeof d.note === "string" ? d.note : null,
      created_at: d.created_at,
    });
  }
  return out;
}

export type BookingVoucher =
  | { enabled: false }
  | { enabled: true; applied: false }
  | { enabled: true; applied: true; code: string; kind: VoucherKind; appliedMinor: number };

export function parseBookingVoucher(data: unknown): BookingVoucher {
  if (!data || typeof data !== "object") return { enabled: false };
  const d = data as Record<string, unknown>;
  if (d.enabled !== true) return { enabled: false };
  if (d.applied !== true) return { enabled: true, applied: false };
  const kind = d.kind === "discount" ? "discount" : "gift";
  const applied = typeof d.applied_minor === "number" && Number.isFinite(d.applied_minor) ? d.applied_minor : 0;
  return typeof d.code === "string"
    ? { enabled: true, applied: true, code: d.code, kind, appliedMinor: applied }
    : { enabled: true, applied: false };
}

/**
 * The database's refusal as a page code. NOT_FOUND is a permission refusal. "loyalty off" is the group's plan flag (vouchers share the
 * loyalty flag).
 */
export function voucherError(
  message: string,
):
  | "setup_forbidden"
  | "voucher_invalid"
  | "voucher_flag"
  | "voucher_unknown"
  | "voucher_expired"
  | "voucher_used"
  | "voucher_void"
  | "voucher_discount"
  | "voucher_state"
  | null {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: loyalty off/.test(message)) return "voucher_flag";
  if (/POLICY_VIOLATION: voucher expired/.test(message)) return "voucher_expired";
  if (/POLICY_VIOLATION: voucher used/.test(message)) return "voucher_used";
  if (/POLICY_VIOLATION: voucher void/.test(message)) return "voucher_void";
  if (/POLICY_VIOLATION: voucher/.test(message)) return "voucher_unknown";
  if (/INVALID_STATE: discount/.test(message)) return "voucher_discount";
  if (/INVALID_STATE: (void|used)/.test(message)) return "voucher_state";
  if (/INVALID_STATE/.test(message)) return "voucher_state";
  if (/POLICY_VIOLATION: (kind|amount|expiry|note|reason|code)/.test(message)) return "voucher_invalid";
  return null;
}
