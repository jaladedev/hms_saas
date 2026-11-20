"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { classifySetupError } from "./room-setup";
import { parseIssueForm, parseRedeemForm, parseVoidForm, voucherError } from "./vouchers";

/**
 * Voucher actions (migration 161). They run as the signed-in person; the database checks permission (property.configure to issue and
 * void, discount.apply to spend), the loyalty flag, the voucher's balance and expiry, and the state of the booking, and answers NOT_FOUND
 * to anyone else, shown as a permission refusal.
 */
const PAGE = "/app/settings/vouchers";

function fromDb(message: string, code: string | undefined) {
  return voucherError(message) ?? classifySetupError({ message, code });
}

export async function issueVoucher(formData: FormData) {
  const v = parseIssueForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const i = v.value;
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("voucher_issue", {
    p_property: i.propertyId,
    p_kind: i.kind,
    p_amount_minor: i.amountMinor,
    p_expires_on: i.expiresOn as string,
    p_note: i.note as string,
    p_idempotency_key: String(formData.get("key") ?? crypto.randomUUID()).slice(0, 80),
  });
  if (error) return back(PAGE, { err: fromDb(error.message, error.code) });
  revalidatePath(PAGE);
  const code = data && typeof data === "object" && "code" in data ? String((data as { code: unknown }).code) : "";
  return back(PAGE, code ? { ok: "voucher_issued", vc: code } : { ok: "voucher_issued" });
}

export async function voidVoucher(formData: FormData) {
  const v = parseVoidForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("voucher_void", { p_voucher: v.value.voucherId, p_reason: v.value.reason });
  if (error) return back(PAGE, { err: fromDb(error.message, error.code) });
  revalidatePath(PAGE);
  return ok(PAGE, "voucher_voided");
}

/** Spends a voucher as the discount on a booking. The page the person came from is passed back so they land where they were. */
export async function redeemVoucher(formData: FormData) {
  const v = parseRedeemForm(Object.fromEntries(formData));
  const page = reservationPage(formData);
  if (!v.ok) return back(page, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("voucher_redeem", {
    p_reservation: v.value.reservationId,
    p_code: v.value.code,
    p_idempotency_key: String(formData.get("key") ?? crypto.randomUUID()).slice(0, 80),
  });
  if (error) return back(page, { err: fromDb(error.message, error.code) });
  revalidatePath(page);
  return ok(page, "voucher_redeemed");
}

export async function releaseVoucher(formData: FormData) {
  const reservationId = String(formData.get("reservationId") ?? "");
  const page = reservationPage(formData);
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) return back(page, { err: "voucher_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("voucher_release", {
    p_reservation: reservationId,
    p_idempotency_key: String(formData.get("key") ?? crypto.randomUUID()).slice(0, 80),
  });
  if (error) return back(page, { err: fromDb(error.message, error.code) });
  revalidatePath(page);
  return ok(page, "voucher_released");
}

/** Only an in-app path under /app/reservations may be returned to, so a form cannot send a person elsewhere. */
function reservationPage(formData: FormData): string {
  const p = String(formData.get("returnTo") ?? "");
  return /^\/app\/reservations\/[0-9a-f-]{36}$/i.test(p) ? p : PAGE;
}
