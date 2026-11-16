import { notFound } from "next/navigation";
import { z } from "zod";
import { formatDate } from "@/lib/guest-site/format";
import { buildInvoicePdf, invoiceFilename } from "@/lib/pdf/invoice";
import { pickInvoice } from "@/lib/staff/documents";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The booking's invoice as a PDF for staff to send or print: the same invoice the documents page shows (`pickInvoice`), with the
 * values saved on it and its lines, never today's rates. Everything is read as the signed-in person, so row-level security decides
 * what exists for them: someone who cannot read the invoice gets "not found", and the guest's name appears only for someone who may
 * read guests. A withdrawn invoice is marked VOID.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: res } = await supabase
    .from("reservations")
    .select("id, property_id, booking_reference, primary_guest_id")
    .eq("id", id)
    .maybeSingle();
  if (!res) notFound();

  const { data: invRows } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, invoice_status, currency, subtotal_minor, tax_minor, service_minor, discount_minor, total_minor, issued_at, void_reason",
    )
    .eq("reservation_id", id);
  const invoice = pickInvoice(invRows ?? []);
  if (!invoice) notFound();

  const [propQ, guestQ, lineQ] = await Promise.all([
    supabase.from("properties").select("name, address, city, state, phone, contact_email").eq("id", res.property_id).maybeSingle(),
    supabase.from("guests").select("full_name").eq("id", res.primary_guest_id).maybeSingle(),
    supabase
      .from("invoice_lines")
      .select("id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date")
      .eq("invoice_id", invoice.id)
      .order("service_date")
      .order("id"),
  ]);
  const prop = propQ.data;
  if (!prop) notFound();

  const bytes = await buildInvoicePdf({
    hotelName: prop.name,
    hotelAddress: [prop.address, prop.city, prop.state].filter(Boolean).join(", ") || null,
    hotelPhone: prop.phone ?? null,
    hotelEmail: prop.contact_email ?? null,
    invoiceNumber: invoice.invoice_number,
    issuedOn: formatDate(invoice.issued_at.slice(0, 10)),
    reference: res.booking_reference,
    guestName: guestQ.data?.full_name ?? null,
    currency: invoice.currency,
    lines: (lineQ.data ?? []).map((l) => ({
      date: l.service_date ? formatDate(l.service_date) : null,
      description: l.description,
      quantity: l.quantity,
      unitMinor: l.unit_amount_minor,
      taxMinor: l.tax_amount_minor,
      totalMinor: l.line_total_minor,
    })),
    subtotalMinor: invoice.subtotal_minor,
    discountMinor: invoice.discount_minor,
    serviceMinor: invoice.service_minor,
    taxMinor: invoice.tax_minor - invoice.service_minor,
    totalMinor: invoice.total_minor,
    voided: invoice.invoice_status === "void" ? { reason: invoice.void_reason ?? null } : null,
  });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoiceFilename(invoice.invoice_number)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
