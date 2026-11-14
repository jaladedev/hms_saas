import { notFound } from "next/navigation";
import { formatDate, formatTime } from "@/lib/guest-site/format";
import { showsAmountDue } from "@/lib/guest-site/booking-summary";
import { bookingStatus, guestHotel, requestHost, verifiedBookingId } from "@/lib/guest-site/server";
import { buildConfirmationPdf, confirmationFilename } from "@/lib/pdf/confirmation";
import { CONFIRMATION_STATUSES, STATUS_LABEL_FOR_PDF } from "@/lib/staff/documents";
import { nightsBetween } from "@/lib/staff/reservations";

export const dynamic = "force-dynamic";

/**
 * The guest's booking confirmation as a PDF. The booking link is the credential, as on the booking page: a link that is not genuine,
 * not current or not for a confirmed booking is "not found". The PDF carries only what the booking page already shows, with the
 * hotel's name and contact details; it has no guest name or email, because the guest-facing booking record holds neither.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) notFound();
  const result = await bookingStatus(reservationId);
  if (!result.ok) notFound();
  const b = result.data;
  if (!(CONFIRMATION_STATUSES as readonly string[]).includes(b.status)) notFound();
  const hotelResult = await guestHotel(await requestHost());
  const hotel = hotelResult.ok ? hotelResult.data : null;

  const bytes = await buildConfirmationPdf({
    hotelName: hotel?.name ?? b.property_name,
    hotelAddress: hotel ? [hotel.address, hotel.city, hotel.state].filter(Boolean).join(", ") || null : null,
    hotelPhone: hotel?.phone ?? null,
    hotelEmail: hotel?.email ?? null,
    reference: b.booking_reference,
    statusLabel: STATUS_LABEL_FOR_PDF[b.status] ?? b.status,
    guestName: null,
    arrival: formatDate(b.arrival_date),
    departure: formatDate(b.departure_date),
    nights: nightsBetween(b.arrival_date, b.departure_date),
    checkIn: formatTime(b.check_in_time),
    checkOut: formatTime(b.check_out_time),
    rooms: b.rooms.map((r) => ({ label: r.room_type, adults: r.adults, children: r.children })),
    currency: b.currency,
    lines: [],
    totalMinor: b.total_minor,
    paidMinor: b.paid_minor,
    outstandingMinor: showsAmountDue(b.status) ? b.outstanding_minor : null,
  });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${confirmationFilename(b.booking_reference)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
