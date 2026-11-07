/**
 * A percentage discount on a booking (migration 058, `apply_discount`). Pure functions, so they can be tested.
 * The database decides who may discount, how far (a cap per role), and whether the booking can still change; these
 * helpers decide whether the form is worth showing, check its shape, and word the refusals.
 *
 * The rule the screen explains: a discount can be set or changed only while the booking is confirmed and NOTHING is paid
 * and no live invoice exists, the same guard as editing dates, so a changed total never breaks money already taken.
 * Setting a discount replaces the one before it; 0 removes it.
 */
import type { ErrorCode } from "./refunds";

export const DISCOUNT_REASON_MAX = 200;

export type DiscountView =
  | { kind: "hidden" }
  | { kind: "blocked"; why: "paid" | "invoiced" }
  | { kind: "editable"; currentPercent: number | null };

export function discountView(args: {
  canApply: boolean; reservationStatus: string; paymentCount: number; liveInvoiceCount: number; currentPercent: number | null;
}): DiscountView {
  if (!args.canApply || args.reservationStatus !== "confirmed") return { kind: "hidden" };
  if (args.paymentCount > 0) return { kind: "blocked", why: "paid" };
  if (args.liveInvoiceCount > 0) return { kind: "blocked", why: "invoiced" };
  return { kind: "editable", currentPercent: args.currentPercent };
}

export function blockedText(why: "paid" | "invoiced"): string {
  return why === "paid"
    ? "A discount cannot be set or changed because a payment has been recorded on this booking."
    : "A discount cannot be set or changed while an invoice is issued. Void the invoice (an invoice with payments cannot be voided) and then change it.";
}

export type DiscountInput = { percent: number; reason: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

/** "10", "7.5" or "7.50"; up to two decimals, from 0 (remove) to 100. Anything else is refused before the database is asked. */
export function parsePercent(raw: unknown): number | null {
  const s = typeof raw === "string" ? raw.trim().replace(/%$/, "").trim() : "";
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 100 ? n : null;
}

export function parseDiscountForm(raw: Record<string, FormDataEntryValue | undefined>): Parsed<DiscountInput> {
  const percent = parsePercent(raw.percent);
  if (percent === null) return { ok: false, code: "dc_percent" };
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason === "" || reason.length > DISCOUNT_REASON_MAX) return { ok: false, code: "dc_reason" };
  return { ok: true, value: { percent, reason } };
}

export function classifyDiscountError(message: string): ErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "se_duplicate";
  if (/POLICY_VIOLATION: percent/.test(message)) return "dc_percent";
  if (/POLICY_VIOLATION: reason/.test(message)) return "dc_reason";
  if (/POLICY_VIOLATION: discount limit/.test(message)) return "dc_limit";
  if (/INVALID_STATE: money held/.test(message)) return "se_paid";
  if (/INVALID_STATE: invoice/.test(message)) return "se_invoiced";
  if (/INVALID_STATE: payment in progress/.test(message)) return "se_payment_started";
  if (/INVALID_STATE/.test(message)) return "dc_status";
  if (/NOT_FOUND/.test(message)) return "not_found";
  return "unknown";
}

export function resultCode(data: unknown): "discount_set" | "discount_removed" | "discount_unchanged" {
  const d = data as { changed?: boolean; discount_percent?: number | string } | null;
  if (d && d.changed === false) return "discount_unchanged";
  return Number(d?.discount_percent ?? 0) === 0 ? "discount_removed" : "discount_set";
}
