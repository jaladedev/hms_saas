import "server-only";
import { headers } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { friendlyError, type GuestError } from "@/lib/guest-site/errors";
import type { StayParams } from "@/lib/guest-site/params";

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

async function call<T>(fn: string, args: Record<string, unknown>): Promise<Result<T>> {
  const { data, error } = await createServiceClient().rpc(fn, args);
  if (error) return { ok: false, error: friendlyError(error.message) };
  return { ok: true, data: data as T };
}

export function searchAvailability(host: string, stay: StayParams) {
  return call<Availability>("search_availability", {
    p_host: host, p_arrival: stay.arrival, p_departure: stay.departure, p_adults: stay.adults, p_children: stay.children,
  });
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

export function bookingStatus(reservationId: string) {
  return call<BookingStatus>("guest_booking_status", { p_reservation_id: reservationId });
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
