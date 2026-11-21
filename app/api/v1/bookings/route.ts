import { apiErrorFor, apiJson, apiRoute } from "@/lib/api/v1";
import { parseCreateBooking, parseIdempotencyKey } from "@/lib/api/booking-input";
import { createBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/v1/bookings?arrival_from=&arrival_to=&status=&limit= (scope bookings.read; guest name and email only with guests.read). Up to 100, by arrival date. */
export async function GET(request: Request) {
  return apiRoute(request, "bookings.read", async (ctx, url) => {
    const from = url.searchParams.get("arrival_from") ?? "";
    const to = url.searchParams.get("arrival_to") ?? "";
    const limit = url.searchParams.get("limit");
    if (!DATE.test(from) || !DATE.test(to))
      return apiJson(400, { error: "invalid_request", message: "arrival_from and arrival_to are required as YYYY-MM-DD." });
    if (limit !== null && !/^\d{1,3}$/.test(limit))
      return apiJson(400, { error: "invalid_request", message: "limit must be a number from 1 to 100." });
    const { data, error } = await createServiceClient().rpc("api_bookings", {
      p_property: ctx.propertyId,
      p_from: from,
      p_to: to,
      p_status: url.searchParams.get("status") as string,
      p_limit: limit === null ? 50 : Number(limit),
      p_guest: ctx.scopes.includes("guests.read"),
    });
    if (error) return apiErrorFor(error.message);
    return apiJson(200, data);
  });
}

const BOOKING_LINK_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * POST /api/v1/bookings (scope bookings.write) holds the rooms for a guest exactly as the hotel's own booking website does and answers 201 with
 * the booking reference, the hold's expiry, the total and `payment_url`, the guest's private booking page where they pay. Nothing is paid or
 * confirmed by this call. Needs an `Idempotency-Key` header (8 to 100 characters): repeating the call with the same key and body returns the same
 * booking, and the same key with a different body is refused (409). A key may have 20 unpaid holds at a time.
 */
export async function POST(request: Request) {
  return apiRoute(request, "bookings.write", async (ctx) => {
    const idem = parseIdempotencyKey(request.headers.get("idempotency-key"));
    if (!idem)
      return apiJson(400, {
        error: "invalid_request",
        message: "Send an Idempotency-Key header of 8 to 100 letters, digits or - _ . : characters.",
      });
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return apiJson(400, { error: "invalid_request", message: "The body must be JSON." });
    }
    const parsed = parseCreateBooking(raw);
    if (!parsed.ok) return apiJson(400, { error: "invalid_request", message: parsed.message });
    const v = parsed.value;
    const { data, error } = await createServiceClient().rpc("api_create_booking", {
      p_property: ctx.propertyId,
      p_key: ctx.keyId,
      p_idempotency: idem,
      p_arrival: v.stay.arrival,
      p_departure: v.stay.departure,
      p_adults: v.stay.adults,
      p_children: v.stay.children,
      p_room_type: v.room_type_id,
      p_quantity: v.quantity,
      p_guest: v.guest,
      ...(v.promo_code ? { p_promo: v.promo_code } : {}),
    });
    if (error) return apiErrorFor(error.message);
    const made = data as {
      reservation_id: string;
      host: string;
      booking: { booking_reference: string; hold_expires_at: string | null; total_minor: number; currency: string };
    };
    const token = createBookingToken(made.reservation_id, serverEnv().BOOKING_TOKEN_SECRET, BOOKING_LINK_TTL_SECONDS);
    const scheme = process.env.EMAIL_LINK_SCHEME === "http" ? "http" : "https";
    return apiJson(201, {
      reference: made.booking.booking_reference,
      status: "pending",
      hold_expires_at: made.booking.hold_expires_at,
      total_minor: made.booking.total_minor,
      currency: made.booking.currency,
      payment_url: `${scheme}://${made.host}/booking/${token}`,
    });
  });
}
