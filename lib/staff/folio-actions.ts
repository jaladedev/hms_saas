"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { back, staffClient } from "./action-helpers";
import { classifyFolioError, parseChargeForm, parsePaymentForm, parseReason } from "./folio";
import type { OkCode } from "./refunds";

/**
 * Staff actions on a reservation's folio (migration 027). Each runs as the signed-in person, never the service role,
 * so the database decides who may do what: `folio.charge` posts and voids, `payment.record` takes the money and
 * `refund.approve` reverses it. These functions check the shape of the form, carry the request and turn the answer into
 * a redirect with a short code. They land on the Folio section of the reservation page (`#folio`), where the result is shown.
 *
 * Posting and paying carry an idempotency key made when the page rendered, so a double click or a retry returns the
 * first answer. A void or a reversal is repeat-safe in the database: the second one changes nothing.
 */

const uuid = z.guid();
const key = z.string().min(8).max(100);
const LIST = "/app/reservations";
const pageFor = (reservationId: string) => `${LIST}/${reservationId}`;

/** Back to the folio of a reservation with a result code in the URL. */
function toFolio(reservationId: string, params: Record<string, string | number>): never {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  redirect(`${pageFor(reservationId)}?${qs.toString()}#folio`);
}

function finish(reservationId: string, error: { message: string } | null, code: OkCode): never {
  if (error) {
    const c = classifyFolioError(error.message);
    return toFolio(reservationId, c.n !== undefined ? { err: c.code, n: c.n } : { err: c.code });
  }
  revalidatePath(pageFor(reservationId));
  return toFolio(reservationId, { ok: code });
}

/** Adds an extra to the folio: a category, words, a quantity and a price each. The database works out any tax. */
export async function postFolioCharge(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const ids = z.object({ reservationId: uuid, idempotencyKey: key }).safeParse(raw);
  if (!ids.success) return back(LIST, { err: "bad_request" });
  const id = ids.data.reservationId;

  const v = parseChargeForm(raw);
  if (!v.ok) return toFolio(id, { err: v.code });
  const c = v.value;

  const supabase = await staffClient();
  const { error } = await supabase.rpc("post_folio_charge", {
    p_reservation_id: id, p_category: c.category, p_description: c.description, p_quantity: c.quantity,
    p_unit_amount_minor: c.unitAmountMinor, p_idempotency_key: ids.data.idempotencyKey,
    p_charge_date: c.date, p_reservation_room_id: c.roomId,
  });
  return finish(id, error, "fo_posted");
}

/** Takes a charge off the folio, with a reason. A charge is never edited: void it and add it again. */
export async function voidFolioCharge(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const ids = z.object({ reservationId: uuid, chargeId: uuid }).safeParse(raw);
  if (!ids.success) return back(LIST, { err: "bad_request" });
  const id = ids.data.reservationId;

  const reason = parseReason(raw.reason);
  if (!reason.ok) return toFolio(id, { err: reason.code });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("void_folio_charge", { p_charge_id: ids.data.chargeId, p_reason: reason.value });
  return finish(id, error, "fo_voided");
}

/** Records money taken for the extras (cash, transfer, POS). It can never be more than what is owed. */
export async function recordFolioPayment(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const ids = z.object({ reservationId: uuid, idempotencyKey: key }).safeParse(raw);
  if (!ids.success) return back(LIST, { err: "bad_request" });
  const id = ids.data.reservationId;

  const v = parsePaymentForm(raw);
  if (!v.ok) return toFolio(id, { err: v.code });
  const p = v.value;

  const supabase = await staffClient();
  const { error } = await supabase.rpc("record_folio_payment", {
    p_reservation_id: id, p_amount_minor: p.amountMinor, p_method: p.method, p_reference: p.reference, p_note: p.note,
    p_idempotency_key: ids.data.idempotencyKey,
  });
  return finish(id, error, "fo_payment");
}

/** Undoes a payment recorded by mistake. It puts the amount back on what the guest owes; it pays nothing back. */
export async function reverseFolioPayment(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const ids = z.object({ reservationId: uuid, paymentId: uuid }).safeParse(raw);
  if (!ids.success) return back(LIST, { err: "bad_request" });
  const id = ids.data.reservationId;

  const reason = parseReason(raw.reason);
  if (!reason.ok) return toFolio(id, { err: reason.code });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("reverse_folio_payment", { p_payment_id: ids.data.paymentId, p_reason: reason.value });
  return finish(id, error, "fo_reversed");
}
