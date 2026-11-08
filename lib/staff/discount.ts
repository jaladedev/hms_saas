/**
 * A percentage discount on a booking (migration 058, `apply_discount`). Pure functions, so they can be tested.
 * The database decides who may discount, how far (a cap per role), and whether the booking can still change; these
 * helpers decide whether the form is worth showing, check its shape, and word the refusals.
 *
 * The rule the screen explains: a discount can be set or changed only while the booking is confirmed and no live invoice
 * exists. Money already paid is fine (migration 065) as long as the new price still covers it; the database enforces that.
 * A discount is a percentage or a fixed naira amount (migration 062), never both. Setting one replaces the one before,
 * of either kind; 0 removes it.
 */
import { parseAmountToMinor } from "./money-input";
import type { ErrorCode } from "./refunds";

export const DISCOUNT_REASON_MAX = 200;

export type DiscountView =
  | { kind: "hidden" }
  | { kind: "blocked"; why: "invoiced" }
  | { kind: "editable"; current: CurrentDiscount };

/** What the booking has now: nothing, a percentage, or an amount in kobo. */
export type CurrentDiscount = { kind: "none" } | { kind: "percent"; percent: number } | { kind: "amount"; amountMinor: number };

export function discountView(args: {
  canApply: boolean; reservationStatus: string; liveInvoiceCount: number; current: CurrentDiscount;
}): DiscountView {
  if (!args.canApply || args.reservationStatus !== "confirmed") return { kind: "hidden" };
  if (args.liveInvoiceCount > 0) return { kind: "blocked", why: "invoiced" };
  return { kind: "editable", current: args.current };
}

export function blockedText(_why: "invoiced"): string {
  return "A discount cannot be set or changed while an invoice is issued. Void the invoice (an invoice with payments cannot be voided) and then change it.";
}

export type DiscountInput = { kind: "percent"; percent: number; reason: string } | { kind: "amount"; amountMinor: number; reason: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

/** "10", "7.5" or "7.50"; up to two decimals, from 0 (remove) to 100. Anything else is refused before the database is asked. */
export function parsePercent(raw: unknown): number | null {
  const s = typeof raw === "string" ? raw.trim().replace(/%$/, "").trim() : "";
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 100 ? n : null;
}

/** "0" removes the discount; anything else is a positive naira amount with at most two decimals, such as 5,000 or 2500.50. */
export function parseAmount(raw: unknown): number | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (/^[₦\s]*0+(?:\.0{1,2})?$/.test(s)) return 0;
  return parseAmountToMinor(s);
}

export function parseDiscountForm(raw: Record<string, FormDataEntryValue | undefined>): Parsed<DiscountInput> {
  const amount = raw.kind === "amount";
  const percent = amount ? null : parsePercent(raw.percent);
  const amountMinor = amount ? parseAmount(raw.amount) : null;
  if (amount ? amountMinor === null : percent === null) return { ok: false, code: amount ? "dc_amount" : "dc_percent" };
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason === "" || reason.length > DISCOUNT_REASON_MAX) return { ok: false, code: "dc_reason" };
  return { ok: true, value: amount ? { kind: "amount", amountMinor: amountMinor as number, reason } : { kind: "percent", percent: percent as number, reason } };
}

export function classifyDiscountError(message: string): ErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "se_duplicate";
  if (/POLICY_VIOLATION: percent/.test(message)) return "dc_percent";
  if (/POLICY_VIOLATION: amount/.test(message)) return "dc_amount";
  if (/POLICY_VIOLATION: reason/.test(message)) return "dc_reason";
  if (/POLICY_VIOLATION: discount limit/.test(message)) return "dc_limit";
  if (/POLICY_VIOLATION: below paid/.test(message)) return "dc_below_paid";
  if (/INVALID_STATE: money held/.test(message)) return "se_paid";
  if (/INVALID_STATE: invoice/.test(message)) return "se_invoiced";
  if (/INVALID_STATE: payment in progress/.test(message)) return "se_payment_started";
  if (/INVALID_STATE/.test(message)) return "dc_status";
  if (/NOT_FOUND/.test(message)) return "not_found";
  return "unknown";
}

export function resultCode(data: unknown): "discount_set" | "discount_removed" | "discount_unchanged" {
  const d = data as { changed?: boolean; discount_minor?: number | string } | null;
  if (d && d.changed === false) return "discount_unchanged";
  return Number(d?.discount_minor ?? 0) === 0 ? "discount_removed" : "discount_set";
}
