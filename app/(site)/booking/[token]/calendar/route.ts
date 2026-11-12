import { NextResponse } from "next/server";
import { bookingIcs, icsFileName } from "@/lib/guest-site/calendar";
import { placeLine } from "@/lib/guest-site/hotel";
import { bookingStatus, guestHotel, requestHost, verifiedBookingId } from "@/lib/guest-site/server";

export const dynamic = "force-dynamic";

/** The stay as a calendar file. Only for a booking that stands (confirmed or checked in), and only with the booking link's token. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const result = await bookingStatus(reservationId);
  if (!result.ok || (result.data.status !== "confirmed" && result.data.status !== "checked_in")) {
    return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const b = result.data;
  const hotel = await guestHotel(await requestHost());
  const body = bookingIcs({
    reference: b.booking_reference,
    hotelName: b.property_name,
    place: hotel.ok ? placeLine(hotel.data) || null : null,
    arrivalDate: b.arrival_date,
    departureDate: b.departure_date,
    checkInTime: b.check_in_time,
    checkOutTime: b.check_out_time,
    rooms: b.rooms.map(
      (r) => `${r.room_type}: ${r.adults} ${r.adults === 1 ? "adult" : "adults"}${r.children ? `, ${r.children} children` : ""}`,
    ),
  });
  return new NextResponse(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${icsFileName(b.booking_reference)}"`,
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}
