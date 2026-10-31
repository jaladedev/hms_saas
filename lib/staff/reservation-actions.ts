"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { parseAmountToMinor } from "./money-input";
import { classifyRpcError } from "./refunds";
import { isPaymentMethod } from "./reservations";

/**
 * Staff reservation actions. Like the refund actions, each runs as the signed-in person (never the
 * service role), so the database decides who may do what: permission, state, dates, money caps.
 * These functions carry the request and turn the answer into a redirect with a short code.
 *
 * Every form carries an idempotency key made when the page rendered, so a double click or a browser
 * retry returns the first answer instead of acting twice. Check-in and check-out are naturally
 * repeat-safe: the second call finds the room already moved on and is refused as an invalid state.
 */

const key = z.string().min(8).max(100);
const uuid = z.guid();
const pageFor = (reservationId: string) => `/app/reservations/${reservationId}`;
const LIST = "/app/reservations";

function refresh(reservationId: string) {
  revalidatePath(pageFor(reservationId));
  revalidatePath(`${pageFor(reservationId)}/settlement`);
  revalidatePath(LIST);
}

export async function cancelReservation(formData: FormData) {
  const parsed = z.object({ reservationId: uuid, idempotencyKey: key, reason: z.string().max(500) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);
  if (!parsed.data.reason.trim()) return back(page, { err: "reason_required" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("cancel_reservation", {
    p_reservation_id: parsed.data.reservationId, p_reason: parsed.data.reason.trim(), p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) {
    // The database answers INVALID_STATE for anything that cannot be cancelled any more; say so in those words.
    return classifyRpcError(error.message).code === "invalid_state" ? back(page, { err: "not_cancellable" }) : fail(page, error.message);
  }
  refresh(parsed.data.reservationId);
  return ok(page, "cancelled");
}

export async function checkInRoom(formData: FormData) {
  const parsed = z.object({ reservationId: uuid, reservationRoomId: uuid, overrideReason: z.string().max(500).optional() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);

  const supabase = await staffClient();
  const { error } = await supabase.rpc("check_in", {
    p_reservation_room_id: parsed.data.reservationRoomId, p_override_reason: parsed.data.overrideReason?.trim() || null,
  });
  if (error) return fail(page, error.message);
  refresh(parsed.data.reservationId);
  return ok(page, "checked_in");
}

export async function checkOutRoom(formData: FormData) {
  const parsed = z.object({ reservationId: uuid, reservationRoomId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);

  const supabase = await staffClient();
  const { error } = await supabase.rpc("check_out", { p_reservation_room_id: parsed.data.reservationRoomId, p_override_reason: null });
  if (error) return fail(page, error.message);
  refresh(parsed.data.reservationId);
  return ok(page, "checked_out");
}

export async function recordPayment(formData: FormData) {
  const parsed = z.object({
    reservationId: uuid, idempotencyKey: key, amount: z.string().max(40), method: z.string().max(30),
    reference: z.string().max(200).optional(), note: z.string().max(500).optional(),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);

  const minor = parseAmountToMinor(parsed.data.amount);
  if (minor === null) return back(page, { err: "amount_invalid" });
  if (!isPaymentMethod(parsed.data.method)) return back(page, { err: "method_invalid" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("record_manual_payment", {
    p_reservation_id: parsed.data.reservationId, p_amount_minor: minor, p_method: parsed.data.method,
    p_reference: parsed.data.reference?.trim() || null, p_note: parsed.data.note?.trim() || null,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(page, error.message);
  refresh(parsed.data.reservationId);
  return ok(page, "payment_recorded");
}
