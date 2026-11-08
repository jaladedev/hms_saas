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
export type HoldResult = { reservation_id: string; booking_reference: string; hold_expires_at: string; total_minor: number; currency: string };

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
    p_host: host, p_arrival: stay.arrival, p_departure: stay.departure, p_adults: stay.adults, p_children: stay.children,
  });
}

/** The hotel's name, address, town and check-in and check-out times for the host (migration 041). */
export const guestHotel = cache((host: string) => call<GuestHotel>("guest_hotel", { p_host: host }));

export type GuestPolicy = { currency: string; cancellation_rules: unknown; online_payment: unknown; checkin_payment: unknown; guest_cancellation: unknown };

/** The cancellation and payment policy in force for the hotel behind this host (migration 032). */
export function guestPolicy(host: string) {
  return call<GuestPolicy>("guest_policy", { p_host: host });
}

export function createHold(args: {
  host: string; stay: StayParams; roomTypeId: string; quantity: number;
  guest: { full_name: string; email: string; phone?: string }; idempotencyKey: string;
}) {
  const rooms = Array.from({ length: args.quantity }, () => ({
    room_type_id: args.roomTypeId, adults: args.stay.adults, children: args.stay.children,
  }));
  return call<HoldResult>("create_hold", {
    p_host: args.host, p_arrival: args.stay.arrival, p_departure: args.stay.departure,
    p_rooms: rooms, p_guest: args.guest, p_idempotency_key: args.idempotencyKey,
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
  allowed: boolean; why_not: "status" | "started" | "too_late" | "disabled" | null; currency: string;
  charge_minor: number; held_minor: number; refund_minor: number; still_owed_minor: number; hours_before_arrival: number;
};

export function cancelPreview(reservationId: string) {
  return call<CancelPreview>("guest_cancel_preview", { p_reservation_id: reservationId });
}

export function cancelBooking(reservationId: string, expectedChargeMinor: number, idempotencyKey: string) {
  return call<{ reservation_id: string; status: string; cancellation_charge_minor: number }>("guest_cancel_reservation", {
    p_reservation_id: reservationId, p_expected_charge_minor: expectedChargeMinor, p_idempotency_key: idempotencyKey,
  });
}

export function paymentStartContext(reservationId: string) {
  return call<{ account_id: string; secret_reference: string; guest_email: string; booking_reference: string }>(
    "payment_start_context", { p_reservation_id: reservationId });
}

export function createPaymentAttempt(reservationId: string, idempotencyKey: string) {
  return call<{ attempt_id: string; reference: string; amount_minor: number; currency: string }>(
    "create_payment_attempt", { p_reservation_id: reservationId, p_idempotency_key: idempotencyKey });
}

export function requestBookingLink(host: string, reference: string, email: string) {
  return call<boolean>("request_booking_link", { p_host: host, p_reference: reference, p_email: email });
}
