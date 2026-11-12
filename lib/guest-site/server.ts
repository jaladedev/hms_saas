import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { readBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { friendlyError, type GuestError } from "@/lib/guest-site/errors";
import type { StayParams } from "@/lib/guest-site/params";
import type { GuestHotel } from "@/lib/guest-site/hotel";
import type { Database } from "@/lib/supabase/database";

/** Host the visitor used. It is the ONLY thing that decides which hotel they are booking (tenant_domains). */
export async function requestHost(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0]!.trim();
}

export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = await requestHost();
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: GuestError };

export type NightQuote = { date: string; rate_minor: number };
export type RoomTypeQuote = {
  room_type_id: string;
  name: string;
  description: string | null;
  amenities?: string[]; // absent from answers given before migration 077
  photos?: { path: string; caption: string | null }[]; // absent from answers given before migration 080
  max_adults: number;
  max_children: number;
  max_occupancy: number;
  rooms_available: number;
  nights: NightQuote[];
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
};
export type Availability = {
  property_name: string;
  currency: string;
  check_in_time: string;
  check_out_time: string;
  arrival_date: string;
  departure_date: string;
  nights: number;
  adults: number;
  children: number;
  room_types: RoomTypeQuote[];
};
export type BookingStatus = {
  reservation_id: string;
  booking_reference: string;
  status: string;
  payment_status: string;
  property_name: string;
  timezone: string;
  arrival_date: string;
  departure_date: string;
  check_in_time: string;
  check_out_time: string;
  currency: string;
  total_minor: number;
  paid_minor: number;
  outstanding_minor: number;
  hold_expires_at: string | null;
  rooms: Array<{ room_type: string; adults: number; children: number }>;
};
export type HoldResult = {
  reservation_id: string;
  booking_reference: string;
  hold_expires_at: string;
  total_minor: number;
  currency: string;
};

/** A database function that exists, so a misspelt name fails the typecheck. */
type DbFunction = keyof Database["public"]["Functions"];

async function call<T>(fn: DbFunction, args: Record<string, unknown>): Promise<Result<T>> {
  // The arguments are built by the callers below, from values already validated; the name is what this helper checks.
  const { data, error } = await createServiceClient().rpc(fn, args as never);
  if (error) return { ok: false, error: friendlyError(error.message) };
  return { ok: true, data: data as T };
}

export function searchAvailability(host: string, stay: StayParams) {
  return call<Availability>("search_availability", {
    p_host: host,
    p_arrival: stay.arrival,
    p_departure: stay.departure,
    p_adults: stay.adults,
    p_children: stay.children,
  });
}

/** The hotel's name, address, town and check-in and check-out times for the host (migration 041). */
export const guestHotel = cache((host: string) => call<GuestHotel>("guest_hotel", { p_host: host }));

export type HomeRoomType = {
  room_type_id: string;
  name: string;
  description: string | null;
  amenities: string[];
  photos: { path: string; caption: string | null }[];
  max_adults: number;
  max_children: number;
  max_occupancy: number;
  from_rate_minor: number; // tonight's rate on the default plan, before tax
};
export type HomeRoomTypes = { currency: string; room_types: HomeRoomType[] };

/** The room types a guest could book at the hotel behind this host, with pictures and a "from" price, for the homepage (migration 096). */
export const guestRoomTypes = cache((host: string) => call<HomeRoomTypes>("guest_room_types", { p_host: host }));

export type RoomTypeDetails = {
  currency: string;
  room_type: Omit<HomeRoomType, "from_rate_minor"> & { from_rate_minor: number | null };
  nights: { date: string; rate_minor: number | null }[]; // the next nights on the default plan, before tax; null when no rate
};

/** One bookable room type with all its pictures and the rate for each of the next nights, for the Room Details page (migration 106). */
export const guestRoomType = cache((host: string, roomType: string) =>
  call<RoomTypeDetails>("guest_room_type", { p_host: host, p_room_type: roomType, p_from: null, p_nights: 14 }),
);

/** Whether a room of the type is free on each of the next nights, for the price calendar (migration 114). A yes or no, never a count. */
export const guestRoomTypeAvailability = cache((host: string, roomType: string) =>
  call<{ nights: { date: string; available: boolean }[] }>("guest_room_type_availability", {
    p_host: host,
    p_room_type: roomType,
    p_from: null,
    p_nights: 14,
  }),
);

export type HomeOffer = { title: string; body: string; badge: string | null; valid_to: string | null };

/** The hotel's live offers for the homepage (migration 102): active, inside their dates, at most six. */
export const guestOffers = cache((host: string) => call<{ offers: HomeOffer[] }>("guest_offers", { p_host: host }));

export type ReviewState = { can_review: boolean; review: { rating: number; comment: string; status: string } | null };
export type PublicReview = { rating: number; comment: string; author: string; month: string };
export type PublicReviews = { average: number | null; count: number; reviews: PublicReview[] };

/** Whether this booking can be reviewed, and its review if there is one (migration 104). */
export function reviewState(reservationId: string) {
  return call<ReviewState>("guest_review_state", { p_reservation_id: reservationId });
}

/** Stores a guest's review as pending; the hotel approves it before it shows (migration 104). */
export function submitReview(reservationId: string, rating: number, comment: string) {
  return call<{ review_id: string }>("submit_guest_review", { p_reservation_id: reservationId, p_rating: rating, p_comment: comment });
}

/** The hotel's approved reviews for the homepage: average, count and the newest six (migration 104). */
export const guestReviews = cache((host: string) => call<PublicReviews>("guest_reviews_public", { p_host: host }));

export type GuestPolicy = {
  currency: string;
  cancellation_rules: unknown;
  online_payment: unknown;
  checkin_payment: unknown;
  guest_cancellation: unknown;
};

/** The cancellation and payment policy in force for the hotel behind this host (migration 032). */
export function guestPolicy(host: string) {
  return call<GuestPolicy>("guest_policy", { p_host: host });
}

export function createHold(args: {
  host: string;
  stay: StayParams;
  roomTypeId: string;
  quantity: number;
  guest: { full_name: string; email: string; phone?: string; address?: string; special_requests?: string };
  idempotencyKey: string;
}) {
  const rooms = Array.from({ length: args.quantity }, () => ({
    room_type_id: args.roomTypeId,
    adults: args.stay.adults,
    children: args.stay.children,
  }));
  return call<HoldResult>("create_hold", {
    p_host: args.host,
    p_arrival: args.stay.arrival,
    p_departure: args.stay.departure,
    p_rooms: rooms,
    p_guest: args.guest,
    p_idempotency_key: args.idempotencyKey,
  });
}

/** The reservation a guest link opens: the token must be genuine, unexpired and issued after any reset by staff (migration 066). */
export async function verifiedBookingId(token: string): Promise<string | null> {
  const t = readBookingToken(token, serverEnv().BOOKING_TOKEN_SECRET);
  if (!t) return null;
  const { data, error } = await createServiceClient().rpc("guest_link_ok", { p_reservation_id: t.reservationId, p_issued_at: t.issuedAt });
  return !error && data === true ? t.reservationId : null;
}

export function bookingStatus(reservationId: string) {
  return call<BookingStatus>("guest_booking_status", { p_reservation_id: reservationId });
}

export type CancelPreview = {
  allowed: boolean;
  why_not: "status" | "started" | "too_late" | "disabled" | null;
  currency: string;
  charge_minor: number;
  held_minor: number;
  refund_minor: number;
  still_owed_minor: number;
  hours_before_arrival: number;
};

export function cancelPreview(reservationId: string) {
  return call<CancelPreview>("guest_cancel_preview", { p_reservation_id: reservationId });
}

export function cancelBooking(reservationId: string, expectedChargeMinor: number, idempotencyKey: string) {
  return call<{ reservation_id: string; status: string; cancellation_charge_minor: number }>("guest_cancel_reservation", {
    p_reservation_id: reservationId,
    p_expected_charge_minor: expectedChargeMinor,
    p_idempotency_key: idempotencyKey,
  });
}

export type ChangeOptions = {
  allowed: boolean;
  why_not: "disabled" | "status" | "started" | null;
  dates_open: boolean;
  window_hours: number;
  hours_before_arrival: number;
  phone: string | null;
  open_request: {
    id: string;
    kind: "dates" | "room" | "other";
    arrival: string | null;
    departure: string | null;
    message: string | null;
    created_at: string;
  } | null;
  last_answer: { status: "done" | "declined"; note: string | null; resolved_at: string } | null;
};

export function changeOptions(reservationId: string) {
  return call<ChangeOptions>("guest_change_options", { p_reservation_id: reservationId });
}

export function updateContact(reservationId: string, phone: string, idempotencyKey: string) {
  return call<{ updated: boolean }>("guest_update_contact", {
    p_reservation_id: reservationId,
    p_phone: phone,
    p_idempotency_key: idempotencyKey,
  });
}

export function requestChange(args: {
  reservationId: string;
  kind: "dates" | "room" | "other";
  arrival: string | null;
  departure: string | null;
  message: string | null;
  idempotencyKey: string;
}) {
  return call<{ request_id: string }>("guest_request_change", {
    p_reservation_id: args.reservationId,
    p_kind: args.kind,
    p_arrival: args.arrival,
    p_departure: args.departure,
    p_message: args.message,
    p_idempotency_key: args.idempotencyKey,
  });
}

export function withdrawChange(reservationId: string) {
  return call<{ withdrawn: boolean }>("guest_withdraw_change_request", { p_reservation_id: reservationId });
}

export type DatesQuote = {
  allowed: boolean;
  why_not: string | null;
  currency: string;
  old_total_minor: number;
  new_total_minor: number | null;
  difference_minor: number | null;
  paid_minor: number;
  nights_added: number | null;
  nights_dropped: number | null;
};

export function datesQuote(reservationId: string, arrival: string, departure: string) {
  return call<DatesQuote>("guest_change_dates_quote", { p_reservation_id: reservationId, p_arrival: arrival, p_departure: departure });
}

export function changeDates(args: {
  reservationId: string;
  arrival: string;
  departure: string;
  expectedTotalMinor: number;
  idempotencyKey: string;
}) {
  return call<{ arrival_date: string; departure_date: string; total_minor: number }>("guest_change_dates", {
    p_reservation_id: args.reservationId,
    p_arrival: args.arrival,
    p_departure: args.departure,
    p_expected_total_minor: args.expectedTotalMinor,
    p_idempotency_key: args.idempotencyKey,
  });
}

export function paymentStartContext(reservationId: string) {
  return call<{ account_id: string; secret_reference: string; guest_email: string; booking_reference: string }>("payment_start_context", {
    p_reservation_id: reservationId,
  });
}

export function createPaymentAttempt(reservationId: string, idempotencyKey: string) {
  return call<{ attempt_id: string; reference: string; amount_minor: number; currency: string }>("create_payment_attempt", {
    p_reservation_id: reservationId,
    p_idempotency_key: idempotencyKey,
  });
}

export function requestBookingLink(host: string, reference: string, email: string) {
  return call<boolean>("request_booking_link", { p_host: host, p_reference: reference, p_email: email });
}
