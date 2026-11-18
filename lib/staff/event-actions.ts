"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, staffClient } from "./action-helpers";
import { failEvent, okEvent } from "./event-action-helpers";
import {
  checkInProblem,
  isUuid,
  parseBookingForm,
  parseEventForm,
  parseMoneyForm,
  parseQuoteLines,
  parseSellForm,
  parseTermsForm,
  parseTicketTypeForm,
  parseVenueForm,
} from "./events";

const SETTINGS = "/app/settings/events";
const BOOKINGS = "/app/events";
const TICKETS = "/app/events/tickets";
const bookingPage = (id: string) => `${BOOKINGS}/${id}`;
const eventPage = (id: string) => `${TICKETS}/${id}`;
const keySchema = z.string().min(8).max(100);
const raw = (formData: FormData) => Object.fromEntries(formData) as Record<string, unknown>;

/** Only pages of this feature may be returned to, so a forged field cannot send someone elsewhere. */
function safeReturn(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\/app\/events(\/[0-9a-f-]{36}|\/tickets\/[0-9a-f-]{36}|\/tickets)?$/i.test(value)
    ? value
    : fallback;
}
const nul = (v: string) => (v === "" ? null : v);

// ---- setup -------------------------------------------------------------------------------------------------------------------------------
export async function saveVenue(formData: FormData) {
  const p = parseVenueForm(raw(formData));
  if (!p.ok) return back(SETTINGS, { err: "ev_invalid" });
  const v = p.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_hotel_venue", {
    p_property: v.propertyId,
    p_venue: v.venueId,
    p_name: v.name,
    p_body: v.body,
    p_capacity: v.capacity,
    p_hourly: v.hourlyMinor,
    p_day: v.dayMinor,
    p_online: v.online,
    p_active: v.active,
    p_sort: v.sort,
  });
  if (error) return failEvent(SETTINGS, error.message);
  revalidatePath(SETTINGS);
  return okEvent(SETTINGS, "ev_venue_saved");
}

export async function saveEventTerms(formData: FormData) {
  const p = parseTermsForm(raw(formData));
  if (!p.ok) return back(SETTINGS, { err: "ev_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_event_settings", {
    p_property: p.value.propertyId,
    p_tax: p.value.tax,
    p_service: p.value.service,
    p_deposit: p.value.deposit,
    p_hold_hours: p.value.holdHours,
  });
  if (error) return failEvent(SETTINGS, error.message);
  revalidatePath(SETTINGS);
  return okEvent(SETTINGS, "ev_settings_saved");
}

// ---- venue bookings ------------------------------------------------------------------------------------------------------------------------
export async function createBooking(formData: FormData) {
  const input = raw(formData);
  const key = keySchema.safeParse(input.key);
  const p = parseBookingForm(input);
  const NEW = `${BOOKINGS}/new`;
  if (!p.ok || !key.success) return back(NEW, { err: "ev_invalid" });
  const v = p.value;
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("create_venue_booking", {
    p_property: v.propertyId,
    p_venue: v.venueId,
    p_starts: v.startsAt,
    p_ends: v.endsAt,
    p_event_type: v.eventType,
    p_title: v.title,
    p_name: v.name,
    p_email: v.email,
    p_phone: v.phone,
    p_attendees: v.attendees,
    p_note: v.note,
    p_hold: v.hold,
    p_key: key.data,
  });
  if (error) return failEvent(NEW, error.message);
  const id = (data as { booking_id?: string } | null)?.booking_id;
  if (!id) return back(NEW, { err: "unknown" });
  revalidatePath(BOOKINGS);
  return okEvent(bookingPage(id), v.hold ? "ev_booking_held" : "ev_booking_created");
}

export async function saveQuote(formData: FormData) {
  const input = raw(formData);
  const id = input.bookingId;
  if (!isUuid(id)) return back(BOOKINGS, { err: "bad_request" });
  const page = bookingPage(id);
  const lines = parseQuoteLines(input);
  if (!lines.ok) return back(page, { err: "ev_no_lines" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_venue_booking_lines", { p_booking: id, p_lines: lines.value });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, "ev_booking_quoted");
}

export async function holdBooking(formData: FormData) {
  const id = raw(formData).bookingId;
  if (!isUuid(id)) return back(BOOKINGS, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("hold_venue_booking", { p_booking: id });
  if (error) return failEvent(bookingPage(id), error.message);
  revalidatePath(bookingPage(id));
  return okEvent(bookingPage(id), "ev_booking_held");
}

export async function confirmBooking(formData: FormData) {
  const input = raw(formData);
  const id = input.bookingId;
  if (!isUuid(id)) return back(BOOKINGS, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("confirm_venue_booking", { p_booking: id, p_waive_deposit: input.waive === "on" });
  if (error) return failEvent(bookingPage(id), error.message);
  revalidatePath(bookingPage(id));
  return okEvent(bookingPage(id), "ev_booking_confirmed");
}

export async function cancelBooking(formData: FormData) {
  const input = raw(formData);
  const id = input.bookingId;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!isUuid(id)) return back(BOOKINGS, { err: "bad_request" });
  if (reason.length < 1 || reason.length > 200) return back(bookingPage(id), { err: "reason_required" });
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("cancel_venue_booking", { p_booking: id, p_reason: reason });
  if (error) return failEvent(bookingPage(id), error.message);
  revalidatePath(bookingPage(id));
  return okEvent(
    bookingPage(id),
    (data as { status?: string } | null)?.status === "declined" ? "ev_booking_declined" : "ev_booking_cancelled",
  );
}

export async function completeBooking(formData: FormData) {
  const id = raw(formData).bookingId;
  if (!isUuid(id)) return back(BOOKINGS, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("complete_venue_booking", { p_booking: id });
  if (error) return failEvent(bookingPage(id), error.message);
  revalidatePath(bookingPage(id));
  return okEvent(bookingPage(id), "ev_booking_completed");
}

// ---- money: venue bookings and ticket orders -----------------------------------------------------------------------------------------------
async function money(formData: FormData, kind: "payment" | "refund") {
  const input = raw(formData);
  const bookingId = typeof input.bookingId === "string" && input.bookingId !== "" ? input.bookingId : null;
  const orderId = typeof input.orderId === "string" && input.orderId !== "" ? input.orderId : null;
  const fallback = bookingId && isUuid(bookingId) ? bookingPage(bookingId) : BOOKINGS;
  const page = safeReturn(input.returnTo, fallback);
  const key = keySchema.safeParse(input.key);
  const methods = kind === "refund" ? ["cash", "bank_transfer", "pos", "other", "card"] : undefined;
  const p = parseMoneyForm(input, methods);
  if (
    !p.ok ||
    !key.success ||
    (bookingId === null) === (orderId === null) ||
    (bookingId && !isUuid(bookingId)) ||
    (orderId && !isUuid(orderId))
  ) {
    return back(page, { err: "amount_invalid" });
  }
  const supabase = await staffClient();
  const args = {
    p_booking: bookingId,
    p_order: orderId,
    p_amount: p.value.amountMinor,
    p_method: p.value.method,
    p_reference: nul(p.value.reference),
    p_note: nul(p.value.note),
    p_key: key.data,
  };
  const { error } = kind === "payment" ? await supabase.rpc("record_event_payment", args) : await supabase.rpc("record_event_refund", args);
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, kind === "payment" ? "ev_payment_recorded" : "ev_refund_recorded");
}
export async function recordEventPayment(formData: FormData) {
  return money(formData, "payment");
}
export async function recordEventRefund(formData: FormData) {
  return money(formData, "refund");
}

// ---- rooms for the event's guests -----------------------------------------------------------------------------------------------------------
const blockSchema = z.object({
  bookingId: z.guid(),
  roomTypeId: z.guid(),
  rooms: z.coerce.number().int().min(1).max(50),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export async function createRoomBlock(formData: FormData) {
  const parsed = blockSchema.safeParse(raw(formData));
  if (!parsed.success) return back(BOOKINGS, { err: "bad_request" });
  const d = parsed.data;
  const page = bookingPage(d.bookingId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("create_event_room_block", {
    p_booking: d.bookingId,
    p_room_type: d.roomTypeId,
    p_rooms: d.rooms,
    p_start: d.start,
    p_end: d.end,
  });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, "ev_block_created");
}

export async function releaseRoomBlock(formData: FormData) {
  const parsed = z.object({ bookingId: z.guid(), blockId: z.guid() }).safeParse(raw(formData));
  if (!parsed.success) return back(BOOKINGS, { err: "bad_request" });
  const page = bookingPage(parsed.data.bookingId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("release_event_room_block", { p_block: parsed.data.blockId });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, "ev_block_released");
}

/** Links a guest's stay to the event by its booking reference (the reservation list shows it), or removes a link. */
export async function setStayLink(formData: FormData) {
  const input = raw(formData);
  const parsed = z.object({ bookingId: z.guid(), mode: z.enum(["link", "unlink"]) }).safeParse(input);
  if (!parsed.success) return back(BOOKINGS, { err: "bad_request" });
  const page = bookingPage(parsed.data.bookingId);
  const supabase = await staffClient();
  let reservationId = typeof input.reservationId === "string" ? input.reservationId : "";
  if (!isUuid(reservationId)) {
    const ref = typeof input.reference === "string" ? input.reference.trim().toUpperCase() : "";
    if (!/^[A-Z0-9-]{4,20}$/.test(ref)) return back(page, { err: "not_found" });
    const { data } = await supabase.from("reservations").select("id").eq("booking_reference", ref).limit(1).maybeSingle();
    if (!data) return back(page, { err: "not_found" });
    reservationId = (data as { id: string }).id;
  }
  const { error } = await supabase.rpc("set_event_reservation_link", {
    p_booking: parsed.data.bookingId,
    p_reservation: reservationId,
    p_linked: parsed.data.mode === "link",
  });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, parsed.data.mode === "link" ? "ev_link_saved" : "ev_link_removed");
}

// ---- ticketed events -------------------------------------------------------------------------------------------------------------------------
export async function saveEvent(formData: FormData) {
  const p = parseEventForm(raw(formData));
  if (!p.ok) return back(TICKETS, { err: "ev_invalid" });
  const v = p.value;
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("save_hotel_event", {
    p_property: v.propertyId,
    p_event: v.eventId,
    p_title: v.title,
    p_body: v.body,
    p_venue: v.venueId,
    p_starts: v.startsAt,
    p_ends: v.endsAt,
    p_max_per_order: v.maxPerOrder,
    p_sales_close: v.salesCloseAt,
  });
  const here = v.eventId ? eventPage(v.eventId) : TICKETS;
  if (error) return failEvent(here, error.message);
  const id = (data as { event_id?: string } | null)?.event_id ?? v.eventId;
  revalidatePath(TICKETS);
  return okEvent(id ? eventPage(id) : TICKETS, "ev_event_saved");
}

const STATUS_OK = {
  on_sale: "ev_event_on_sale",
  closed: "ev_event_closed",
  draft: "ev_event_draft",
  cancelled: "ev_event_cancelled",
} as const;
export async function setEventStatus(formData: FormData) {
  const parsed = z.object({ eventId: z.guid(), status: z.enum(["draft", "on_sale", "closed", "cancelled"]) }).safeParse(raw(formData));
  if (!parsed.success) return back(TICKETS, { err: "bad_request" });
  const page = eventPage(parsed.data.eventId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_hotel_event_status", { p_event: parsed.data.eventId, p_status: parsed.data.status });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, STATUS_OK[parsed.data.status]);
}

export async function deleteEvent(formData: FormData) {
  const id = raw(formData).eventId;
  if (!isUuid(id)) return back(TICKETS, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_hotel_event", { p_event: id });
  if (error) return failEvent(eventPage(id), error.message);
  revalidatePath(TICKETS);
  return okEvent(TICKETS, "ev_event_deleted");
}

export async function saveTicketType(formData: FormData) {
  const p = parseTicketTypeForm(raw(formData));
  if (!p.ok) {
    const id = raw(formData).eventId;
    return back(isUuid(id) ? eventPage(id) : TICKETS, { err: "ev_invalid" });
  }
  const v = p.value;
  const page = eventPage(v.eventId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_ticket_type", {
    p_event: v.eventId,
    p_type: v.typeId,
    p_name: v.name,
    p_price: v.priceMinor,
    p_quantity: v.quantity,
    p_active: v.active,
    p_sort: v.sort,
  });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, "ev_type_saved");
}

export async function deleteTicketType(formData: FormData) {
  const parsed = z.object({ eventId: z.guid(), typeId: z.guid() }).safeParse(raw(formData));
  if (!parsed.success) return back(TICKETS, { err: "bad_request" });
  const page = eventPage(parsed.data.eventId);
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_ticket_type", { p_type: parsed.data.typeId });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, "ev_type_deleted");
}

/** A desk sale: the order and the payment in one step, then the buyer's codes show on the event page. */
export async function sellTickets(formData: FormData) {
  const input = raw(formData);
  const key = keySchema.safeParse(input.key);
  const p = parseSellForm(input);
  const id = input.eventId;
  const page = isUuid(id) ? eventPage(id) : TICKETS;
  if (!p.ok || !key.success) return back(page, { err: "ev_invalid" });
  const v = p.value;
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("staff_sell_tickets", {
    p_property: v.propertyId,
    p_event: v.eventId,
    p_items: v.items,
    p_name: v.name,
    p_email: nul(v.email),
    p_phone: nul(v.phone),
    p_method: v.method,
    p_reference: nul(v.reference),
    p_key: key.data,
  });
  if (error) return failEvent(page, error.message);
  const ref = (data as { reference?: string } | null)?.reference;
  revalidatePath(page);
  return back(page, { ok: "ev_sold", ...(ref ? { sold: ref } : {}) });
}

export async function cancelTicketOrder(formData: FormData) {
  const input = raw(formData);
  const parsed = z.object({ orderId: z.guid(), eventId: z.guid() }).safeParse(input);
  if (!parsed.success) return back(TICKETS, { err: "bad_request" });
  const page = eventPage(parsed.data.eventId);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > 200) return back(page, { err: "reason_required" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("cancel_ticket_order", { p_order: parsed.data.orderId, p_reason: reason });
  if (error) return failEvent(page, error.message);
  revalidatePath(page);
  return okEvent(page, "ev_order_cancelled");
}

/** The door: one code at a time. The answer rides in the URL as short codes; the page words it. */
export async function checkInTicket(formData: FormData) {
  const parsed = z.object({ propertyId: z.guid(), eventId: z.guid(), code: z.string().trim().min(3).max(20) }).safeParse(raw(formData));
  const id = raw(formData).eventId;
  const page = isUuid(id) ? eventPage(id) : TICKETS;
  if (!parsed.success) return back(page, { door: "unknown" });
  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("ticket_check_in", {
    p_property: parsed.data.propertyId,
    p_code: parsed.data.code,
    p_event: parsed.data.eventId,
  });
  if (error) return back(page, { door: checkInProblem(error.message) });
  const r = (data ?? {}) as { buyer?: string; ticket_type?: string; checked_in?: number; tickets?: number };
  revalidatePath(page);
  return back(page, {
    door: "ok",
    buyer: String(r.buyer ?? "").slice(0, 80),
    type: String(r.ticket_type ?? "").slice(0, 40),
    inn: Number(r.checked_in ?? 0),
    of: Number(r.tickets ?? 0),
  });
}
