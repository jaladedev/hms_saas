import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PrintButton } from "@/components/staff/print-button";
import { linkClass, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { CATEGORY_LABEL } from "@/lib/staff/folio";
import { FOLIO_INVOICE_COLUMNS, FOLIO_LINE_COLUMNS, type FolioInvoiceLine, type FolioInvoiceRow } from "@/lib/staff/folio-invoice";
import { formatDateTime } from "@/lib/staff/format";
import { nightsBetween } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Res = {
  id: string;
  property_id: string;
  booking_reference: string;
  primary_guest_id: string;
  arrival_date: string;
  departure_date: string;
  currency: string;
};
type Prop = { name: string; address: string | null; city: string; state: string; timezone: string };

/**
 * One numbered invoice for extras (migration 048), laid out to print. It shows the frozen copy kept when it was issued, not
 * today's folio, so a later change to the extras never alters it. Who may open it is decided by row-level security: the
 * people who post charges, issue invoices or see money. Guest names show only with guest.view. Payments for extras are not
 * on it, because they belong to the folio and not to one invoice.
 */
export default async function FolioInvoicePage({ params }: { params: Promise<{ id: string; invoiceId: string }> }) {
  const { id, invoiceId } = await params;
  if (!z.guid().safeParse(id).success || !z.guid().safeParse(invoiceId).success) notFound();
  const supabase = await createClient();

  const { data: invRow } = await supabase
    .from("folio_invoices")
    .select(FOLIO_INVOICE_COLUMNS)
    .eq("id", invoiceId)
    .eq("reservation_id", id)
    .maybeSingle();
  if (!invRow) notFound();
  const invoice = invRow as FolioInvoiceRow;
  const { data: resRow } = await supabase
    .from("reservations")
    .select("id, property_id, booking_reference, primary_guest_id, arrival_date, departure_date, currency")
    .eq("id", id)
    .maybeSingle();
  if (!resRow) notFound();
  const res = resRow as Res;

  const [linesQ, propQ, guestQ] = await Promise.all([
    supabase
      .from("folio_invoice_lines")
      .select(FOLIO_LINE_COLUMNS)
      .eq("folio_invoice_id", invoiceId)
      .order("service_date")
      .order("created_at"),
    supabase.from("properties").select("name, address, city, state, timezone").eq("id", res.property_id).maybeSingle(),
    supabase.from("guests").select("full_name").eq("id", res.primary_guest_id).maybeSingle(),
  ]);
  const lines = (linesQ.data ?? []) as FolioInvoiceLine[];
  const prop = (propQ.data ?? { name: "", address: null, city: "", state: "", timezone: "UTC" }) as Prop;
  const guestName = (guestQ.data as { full_name: string } | null)?.full_name ?? null;
  const money = (m: number) => formatMoney(m, res.currency);
  const isVoid = invoice.invoice_status === "void";
  const nights = nightsBetween(res.arrival_date, res.departure_date);

  return (
    <main className="max-w-3xl">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm print:hidden">
        <Link href={`/app/reservations/${id}#folio-invoices`} className={linkClass}>
          Back to the booking
        </Link>
        <PrintButton />
      </p>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Invoice {invoice.invoice_number}</PageTitle>
          <p className="mt-1 text-sm text-muted">For extras charged during the stay</p>
        </div>
        <div className="text-sm sm:text-right">
          <p className="font-medium">{prop.name}</p>
          {prop.address && <p>{prop.address}</p>}
          <p>{[prop.city, prop.state].filter(Boolean).join(", ")}</p>
        </div>
      </div>

      {isVoid && (
        <p role="status" className="mt-4 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">
          <span className="font-semibold">Void.</span> This invoice was withdrawn {formatDateTime(invoice.voided_at, prop.timezone)}
          {invoice.void_reason ? `: ${invoice.void_reason}` : "."} It is kept for the record and is not valid.
        </p>
      )}

      <dl className="mt-6 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Invoice date</dt>
          <dd>{formatDate(invoice.issued_at.slice(0, 10))}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Booking</dt>
          <dd>{res.booking_reference}</dd>
        </div>
        {guestName && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Guest</dt>
            <dd>{guestName}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Stay</dt>
          <dd>
            {formatDate(res.arrival_date)} to {formatDate(res.departure_date)}, {nights} {nights === 1 ? "night" : "nights"}
          </dd>
        </div>
      </dl>

      <div className="mt-8 overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[34rem] text-sm print:min-w-0">
          <caption className="sr-only">Extras on invoice {invoice.invoice_number}</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="py-2 pr-3 font-normal">
                Date
              </th>
              <th scope="col" className="px-2 py-2 font-normal">
                Description
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Qty
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Price
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Tax
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-line tabular-nums">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {formatDate(l.service_date)}
                </th>
                <td className="px-2 py-2">
                  {CATEGORY_LABEL[l.category] ?? l.category}, {l.description}
                </td>
                <td className="px-2 py-2 text-right">{l.quantity}</td>
                <td className="px-2 py-2 text-right">{money(l.unit_amount_minor)}</td>
                <td className="px-2 py-2 text-right">{l.tax_minor > 0 ? money(l.tax_minor) : "–"}</td>
                <td className="px-2 py-2 text-right">{money(l.line_total_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto mt-4 max-w-xs text-sm tabular-nums">
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Before tax</dt>
          <dd>{money(invoice.subtotal_minor)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Tax</dt>
          <dd>{money(invoice.tax_minor)}</dd>
        </div>
        <div className="flex justify-between gap-6 border-t-2 border-ink py-2 text-base font-semibold">
          <dt>Total</dt>
          <dd>{money(invoice.total_minor)}</dd>
        </div>
      </dl>

      <p className="mt-8 max-w-prose text-xs text-muted">
        This is a copy of the extras as they were when the invoice was issued. Money taken for extras is recorded on the booking&rsquo;s
        folio and is not shown here.
      </p>
    </main>
  );
}
