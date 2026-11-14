import { notFound } from "next/navigation";
import { z } from "zod";
import { formatDate } from "@/lib/guest-site/format";
import { buildConfirmationPdf, confirmationFilename } from "@/lib/pdf/confirmation";
import { CONFIRMATION_STATUSES, receiptTotals, STATUS_LABEL_FOR_PDF } from "@/lib/staff/documents";
import { nightsBetween } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * A booking confirmation as a PDF for staff to send or print. Everything is read as the signed-in person, so row-level security decides
 * what exists for them: someone who cannot read the booking gets "not found", and the guest's name appears only for someone who may
 * read guests. Values are the ones saved on the booking, never today's rates.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: res } = await supabase
    .from("reservations")
    .select(
      "id, property_id, booking_reference, primary_guest_id, reservation_status, arrival_date, departure_date, currency, subtotal_minor, tax_minor, discount_minor, total_minor",
    )
    .eq("id", id)
    .maybeSingle();
  if (!res || !(CONFIRMATION_STATUSES as readonly string[]).includes(res.reservation_status)) notFound();

  const [propQ, guestQ, payQ, refQ, roomsQ] = await Promise.all([
    supabase
      .from("properties")
      .select("name, address, city, state, phone, contact_email, check_in_time, check_out_time")
      .eq("id", res.property_id)
      .maybeSingle(),
    supabase.from("guests").select("full_name").eq("id", res.primary_guest_id).maybeSingle(),
    supabase.from("payments").select("amount_minor, payment_status").eq("reservation_id", id),
    supabase.from("refunds").select("amount_minor, refund_status").eq("reservation_id", id),
    supabase.from("reservation_rooms").select("room_type_id, adults, children").eq("reservation_id", id).order("created_at"),
  ]);
  const prop = propQ.data;
  if (!prop) notFound();
  const roomRows = roomsQ.data ?? [];
  const typeIds = [...new Set(roomRows.map((r) => r.room_type_id))];
  const typeQ = typeIds.length ? await supabase.from("room_types").select("id, name").in("id", typeIds) : { data: [] };
  const typeName = new Map((typeQ.data ?? []).map((t) => [t.id, t.name]));

  const paid = receiptTotals(payQ.data ?? [], refQ.data ?? []).kept;
  const lines: { label: string; minor: number }[] = [{ label: "Room charges", minor: res.subtotal_minor }];
  if (res.tax_minor > 0) lines.push({ label: "Tax", minor: res.tax_minor });
  if (res.discount_minor > 0) lines.push({ label: "Discount", minor: -res.discount_minor });

  const bytes = await buildConfirmationPdf({
    hotelName: prop.name,
    hotelAddress: [prop.address, prop.city, prop.state].filter(Boolean).join(", ") || null,
    hotelPhone: prop.phone ?? null,
    hotelEmail: prop.contact_email ?? null,
    reference: res.booking_reference,
    statusLabel: STATUS_LABEL_FOR_PDF[res.reservation_status] ?? res.reservation_status,
    guestName: guestQ.data?.full_name ?? null,
    arrival: formatDate(res.arrival_date),
    departure: formatDate(res.departure_date),
    nights: nightsBetween(res.arrival_date, res.departure_date),
    checkIn: prop.check_in_time.slice(0, 5),
    checkOut: prop.check_out_time.slice(0, 5),
    rooms: roomRows.map((r) => ({ label: typeName.get(r.room_type_id) ?? "Room", adults: r.adults, children: r.children })),
    currency: res.currency,
    lines,
    totalMinor: res.total_minor,
    paidMinor: paid,
    outstandingMinor: res.reservation_status === "checked_out" ? null : Math.max(0, res.total_minor - paid),
  });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${confirmationFilename(res.booking_reference)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
