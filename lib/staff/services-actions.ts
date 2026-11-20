"use server";

import { revalidatePath } from "next/cache";
import { back, staffClient } from "./action-helpers";
import { classifySvcError, parseBookForm, parseServiceForm, parseStepForm, STEP_OK, type SvcErrorCode, type SvcOkCode } from "./services";

/**
 * Spa, gym and laundry actions (migration 151). Each runs as the signed-in person; the database checks the permission (services.book to book
 * and step a booking, services.manage for the list, folio.charge to post to a room bill), the guest_services flag, the slot and the booking's
 * state, and answers with a refusal that is shown as a short code, never as database text.
 */
const DESK = "/app/services";
const SETUP = "/app/settings/services";

const fail = (path: string, code: SvcErrorCode): never => back(path, { svcerr: code });
const done = (path: string, code: SvcOkCode): never => back(path, { svc: code });

export async function saveService(formData: FormData) {
  const v = parseServiceForm(Object.fromEntries(formData));
  if (!v.ok) return fail(SETUP, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("service_save", {
    p_property: v.value.propertyId,
    p_service: v.value.serviceId as string,
    p_name: v.value.name,
    p_kind: v.value.kind,
    p_price: v.value.priceMinor,
    p_duration: v.value.durationMinutes as number,
    p_capacity: v.value.capacity,
    p_active: v.value.active,
    p_sort: v.value.sort,
  });
  if (error) return fail(SETUP, classifySvcError(error.message));
  revalidatePath(SETUP);
  revalidatePath(DESK);
  return done(SETUP, "svc_saved");
}

export async function bookService(formData: FormData) {
  const v = parseBookForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const supabase = await staffClient();
  let reservationId: string | null = null;
  if (v.value.reference) {
    const found = await supabase
      .from("reservations")
      .select("id")
      .eq("property_id", v.value.propertyId)
      .eq("booking_reference", v.value.reference)
      .maybeSingle();
    if (found.error || !found.data) return fail(DESK, "svc_guest");
    reservationId = found.data.id as string;
  }
  const { error } = await supabase.rpc("service_book", {
    p_property: v.value.propertyId,
    p_service: v.value.serviceId,
    p_reservation: reservationId as string,
    p_guest_label: v.value.guestLabel as string,
    p_starts: v.value.startsAt as string,
    p_quantity: v.value.quantity,
    p_note: v.value.note as string,
    p_key: v.value.key,
  });
  if (error) return fail(DESK, classifySvcError(error.message));
  revalidatePath(DESK);
  return done(DESK, "svc_booked");
}

export async function stepServiceBooking(formData: FormData) {
  const v = parseStepForm(Object.fromEntries(formData));
  if (!v.ok) return fail(DESK, v.code);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("service_booking_set", {
    p_booking: v.value.bookingId,
    p_action: v.value.action,
    p_key: `s-${v.value.bookingId}`,
  });
  if (error) return fail(DESK, classifySvcError(error.message));
  revalidatePath(DESK);
  return done(DESK, STEP_OK[v.value.action]);
}
