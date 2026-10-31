"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { parseAmountToMinor } from "./money-input";
import { classifyRpcError } from "./refunds";
import { roomsPayload, validateNewReservation } from "./new-reservation";
import { isPaymentMethod, parseIsoDate } from "./reservations";

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

export async function createManualReservation(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const NEW = `${LIST}/new`;
  const v = validateNewReservation(raw);
  if (!v.ok) return back(NEW, { err: v.code });
  const idempotencyKey = key.safeParse(raw.idempotencyKey);
  if (!idempotencyKey.success) return back(NEW, { err: "bad_request" });
  const { value } = v;

  const supabase = await staffClient();
  const { data: prop } = await supabase.from("properties").select("tenant_id").eq("id", value.propertyId).maybeSingle();
  if (!prop) return back(NEW, { err: "room_type_missing" });

  // Reuse the guest with the same email so repeat visitors keep one record; otherwise add a new one.
  let guestId: string | null = null;
  if (value.guest.email) {
    const { data: found } = await supabase.from("guests").select("id").eq("tenant_id", prop.tenant_id).ilike("email", value.guest.email).order("created_at").limit(1).maybeSingle();
    guestId = found?.id ?? null;
  }
  if (!guestId) {
    const { data: created, error: guestError } = await supabase.from("guests")
      .insert({ tenant_id: prop.tenant_id, full_name: value.guest.name, email: value.guest.email, phone: value.guest.phone })
      .select("id").single();
    if (guestError || !created) return back(NEW, { err: "guest_failed" });
    guestId = created.id;
  }

  const { data, error } = await supabase.rpc("create_reservation", {
    p_property_id: value.propertyId, p_primary_guest_id: guestId, p_source: value.source,
    p_arrival: value.arrival, p_departure: value.departure, p_rooms: roomsPayload(value),
    p_idempotency_key: idempotencyKey.data,
  });
  if (error) return fail(NEW, error.message);
  const reservationId = (data as { reservation_id?: string } | null)?.reservation_id;
  revalidatePath(LIST);
  if (!reservationId) return back(LIST, { ok: "created" });
  return ok(pageFor(reservationId), "created");
}

export async function issueInvoice(formData: FormData) {
  const parsed = z.object({ reservationId: uuid, idempotencyKey: key }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("issue_invoice", { p_reservation_id: parsed.data.reservationId, p_idempotency_key: parsed.data.idempotencyKey });
  if (error) return fail(page, error.message);
  refresh(parsed.data.reservationId);
  return ok(page, "invoice_issued");
}

export async function voidInvoice(formData: FormData) {
  const parsed = z.object({ reservationId: uuid, invoiceId: uuid, idempotencyKey: key, reason: z.string().max(500) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);
  if (!parsed.data.reason.trim()) return back(page, { err: "reason_required" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("void_invoice", {
    p_invoice_id: parsed.data.invoiceId, p_reason: parsed.data.reason.trim(), p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(page, error.message);
  refresh(parsed.data.reservationId);
  return ok(page, "invoice_voided");
}

/**
 * Moves the rest of a guest's stay, from a chosen date, to another room of the same type (a chosen room, or the
 * first free one when none is named). All or nothing: if the new room is taken, the guest keeps the old one.
 */
export async function transferRoom(formData: FormData) {
  const parsed = z.object({
    reservationId: uuid, reservationRoomId: uuid, idempotencyKey: key, newRoomId: z.union([uuid, z.literal("")]),
    effective: z.string().max(10), reason: z.string().max(500),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(LIST, { err: "bad_request" });
  const page = pageFor(parsed.data.reservationId);
  const effective = parseIsoDate(parsed.data.effective);
  if (!effective) return back(page, { err: "bad_request" });
  if (!parsed.data.reason.trim()) return back(page, { err: "reason_required" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("transfer_room", {
    p_reservation_room_id: parsed.data.reservationRoomId, p_new_room_id: parsed.data.newRoomId || null,
    p_effective: effective, p_reason: parsed.data.reason.trim(), p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) {
    // Here "unavailable" means the guest stays where they are, not that a booking failed.
    return classifyRpcError(error.message).code === "room_unavailable" ? back(page, { err: "transfer_unavailable" }) : fail(page, error.message);
  }
  refresh(parsed.data.reservationId);
  revalidatePath("/app/rooms");
  revalidatePath("/app/front-desk");
  return ok(page, "transferred");
}
