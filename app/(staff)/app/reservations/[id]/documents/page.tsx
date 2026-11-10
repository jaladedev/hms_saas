import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PrintButton } from "@/components/staff/print-button";
import { linkClass, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import {
  availableDocs,
  chooseDoc,
  documentsPath,
  DOC_LABEL,
  PAYMENT_METHOD_LABEL,
  pickInvoice,
  receiptTotals,
  REFUND_STATUS_LABEL,
} from "@/lib/staff/documents";
import { formatDateTime } from "@/lib/staff/format";
import { nightsBetween } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Res = {
  id: string;
  property_id: string;
  booking_reference: string;
  primary_guest_id: string;
  reservation_status: string;
  arrival_date: string;
  departure_date: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  discount_minor: number;
  total_minor: number;
  cancellation_charge_minor: number;
  cancelled_at: string | null;
  created_at: string;
};
type Prop = {
  name: string;
  address: string | null;
  city: string;
  state: string;
  timezone: string;
  check_in_time: string;
  check_out_time: string;
};
type Inv = {
  id: string;
  invoice_number: string;
  invoice_status: string;
  subtotal_minor: number;
  tax_minor: number;
  discount_minor: number;
  total_minor: number;
  issued_at: string;
  void_reason: string | null;
  voided_at: string | null;
};
type Line = {
  id: string;
  description: string;
  quantity: number;
  unit_amount_minor: number;
  tax_amount_minor: number;
  line_total_minor: number;
  service_date: string | null;
};
type Pay = {
  id: string;
  payment_method: string;
  provider_reference: string | null;
  internal_reference: string;
  amount_minor: number;
  payment_status: string;
  received_at: string;
};
type Refund = { id: string; amount_minor: number; refund_status: string; created_at: string };

/**
 * Printable documents for one booking (UI spec page 14): confirmation, invoice, receipt, cancellation notice. Everything shown
 * is a value saved on the booking, its nights, its invoice lines and its payments, never today's rates or policy. What a
 * person may open is decided by row-level security, so someone who cannot read invoices or payments simply does not get
 * those documents. Guest name and contact show only with guest.view.
 */
export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();

  const { data: resRow } = await supabase
    .from("reservations")
    .select(
      "id, property_id, booking_reference, primary_guest_id, reservation_status, arrival_date, departure_date, currency, subtotal_minor, tax_minor, discount_minor, total_minor, cancellation_charge_minor, cancelled_at, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (!resRow) notFound();
  const res = resRow as Res;

  const [propQ, guestQ, invQ, payQ, refQ, roomsQ] = await Promise.all([
    supabase
      .from("properties")
      .select("name, address, city, state, timezone, check_in_time, check_out_time")
      .eq("id", res.property_id)
      .maybeSingle(),
    supabase.from("guests").select("full_name, email, phone").eq("id", res.primary_guest_id).maybeSingle(),
    supabase
      .from("invoices")
      .select(
        "id, invoice_number, invoice_status, subtotal_minor, tax_minor, discount_minor, total_minor, issued_at, void_reason, voided_at",
      )
      .eq("reservation_id", id)
      .order("created_at"),
    supabase
      .from("payments")
      .select("id, payment_method, provider_reference, internal_reference, amount_minor, payment_status, received_at")
      .eq("reservation_id", id)
      .order("received_at"),
    supabase.from("refunds").select("id, amount_minor, refund_status, created_at").eq("reservation_id", id).order("created_at"),
    supabase.from("reservation_rooms").select("id, room_type_id, adults, children").eq("reservation_id", id).order("created_at"),
  ]);
  const prop = (propQ.data ?? {
    name: "",
    address: null,
    city: "",
    state: "",
    timezone: "UTC",
    check_in_time: "",
    check_out_time: "",
  }) as Prop;
  const guest = guestQ.data as { full_name: string; email: string | null; phone: string | null } | null;
  const invoices = (invQ.data ?? []) as Inv[];
  const payments = (payQ.data ?? []) as Pay[];
  const refunds = (refQ.data ?? []) as Refund[];
  const resRooms = (roomsQ.data ?? []) as { id: string; room_type_id: string; adults: number; children: number }[];

  const available = availableDocs({
    status: res.reservation_status,
    invoices: invoices.length,
    succeededPayments: payments.filter((p) => p.payment_status === "succeeded").length,
  });
  const kind = chooseDoc(search.doc, available);
  const money = (m: number) => formatMoney(m, res.currency);
  const nights = nightsBetween(res.arrival_date, res.departure_date);
  const tz = prop.timezone;

  const header = (
    <>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm print:hidden">
        <Link href={`/app/reservations/${id}`} className={linkClass}>
          Back to the booking
        </Link>
        {kind && <PrintButton />}
      </p>
      {available.length > 1 && (
        <nav aria-label="Documents for this booking" className="mt-3 flex flex-wrap gap-2 text-sm print:hidden">
          {available.map((k) => (
            <Link
              key={k}
              href={documentsPath(id, k)}
              aria-current={k === kind ? "page" : undefined}
              className={
                k === kind
                  ? "rounded border border-ink bg-ink px-3 py-1.5 text-white"
                  : "rounded border border-line px-3 py-1.5 hover:bg-white"
              }
            >
              {DOC_LABEL[k]}
            </Link>
          ))}
        </nav>
      )}
    </>
  );

  if (!kind) {
    return (
      <main className="max-w-3xl">
        {header}
        <div className="mt-4">
          <PageTitle>Documents</PageTitle>
        </div>
        <p className="mt-3 text-sm text-muted">
          This booking has no documents yet. A confirmation is available once the booking is confirmed; an invoice or a receipt once one has
          been issued or a payment recorded.
        </p>
      </main>
    );
  }

  const letterhead = (
    <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
      <div>
        <PageTitle>{DOC_LABEL[kind]}</PageTitle>
        <p className="mt-1 text-sm text-muted">Booking {res.booking_reference}</p>
      </div>
      <div className="text-sm sm:text-right">
        <p className="font-medium">{prop.name}</p>
        {prop.address && <p>{prop.address}</p>}
        <p>{[prop.city, prop.state].filter(Boolean).join(", ")}</p>
      </div>
    </div>
  );
  const facts = (
    <dl className="mt-6 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
      <div className="flex justify-between gap-4">
        <dt className="text-muted">Booking</dt>
        <dd>{res.booking_reference}</dd>
      </div>
      {guest && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted">Guest</dt>
          <dd>{guest.full_name}</dd>
        </div>
      )}
      <div className="flex justify-between gap-4">
        <dt className="text-muted">Stay</dt>
        <dd>
          {formatDate(res.arrival_date)} to {formatDate(res.departure_date)}, {nights} {nights === 1 ? "night" : "nights"}
        </dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted">Check-in / check-out</dt>
        <dd>
          from {prop.check_in_time.slice(0, 5)} / by {prop.check_out_time.slice(0, 5)}
        </dd>
      </div>
    </dl>
  );
  const th = "px-2 py-2 font-normal";

  // ---- booking confirmation -------------------------------------------------------------------------------------------
  if (kind === "confirmation") {
    const roomIds = resRooms.map((r) => r.id);
    const [nightsQ, typeQ] = await Promise.all([
      roomIds.length
        ? supabase
            .from("reservation_nights")
            .select("reservation_room_id, night_date, rate_minor, tax_minor")
            .in("reservation_room_id", roomIds)
            .order("night_date")
        : { data: [] },
      resRooms.length
        ? supabase
            .from("room_types")
            .select("id, name")
            .in("id", [...new Set(resRooms.map((r) => r.room_type_id))])
        : { data: [] },
    ]);
    const nightRows = (nightsQ.data ?? []) as { reservation_room_id: string; night_date: string; rate_minor: number; tax_minor: number }[];
    const typeNames = new Map(((typeQ.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
    return (
      <main className="max-w-3xl">
        {header}
        {letterhead}
        {facts}
        <p className="mt-6 text-sm">
          Thank you for booking with {prop.name}. Your booking is confirmed. It was made on {formatDate(res.created_at.slice(0, 10))}.
        </p>
        {resRooms.map((r, i) => {
          const rows = nightRows.filter((n) => n.reservation_room_id === r.id);
          return (
            <section key={r.id} className="mt-6">
              <h2 className="text-base font-medium">
                Room {i + 1}: {typeNames.get(r.room_type_id) ?? "Room"} ({r.adults} {r.adults === 1 ? "adult" : "adults"}
                {r.children ? `, ${r.children} ${r.children === 1 ? "child" : "children"}` : ""})
              </h2>
              <table className="mt-2 w-full text-sm print:min-w-0">
                <caption className="sr-only">Nights for room {i + 1}</caption>
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th scope="col" className={`${th} pl-0`}>
                      Night
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Rate
                    </th>
                    <th scope="col" className={`${th} text-right`}>
                      Tax
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((n) => (
                    <tr key={n.night_date} className="border-b border-line tabular-nums">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        {formatDate(n.night_date)}
                      </th>
                      <td className="px-2 py-2 text-right">{money(n.rate_minor)}</td>
                      <td className="px-2 py-2 text-right">{n.tax_minor > 0 ? money(n.tax_minor) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
        <dl className="ml-auto mt-4 max-w-xs text-sm tabular-nums">
          <div className="flex justify-between gap-6 py-1.5">
            <dt className="text-muted">Before tax</dt>
            <dd>{money(res.subtotal_minor)}</dd>
          </div>
          {res.discount_minor > 0 && (
            <div className="flex justify-between gap-6 py-1.5">
              <dt className="text-muted">Discount</dt>
              <dd>-{money(res.discount_minor)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-6 py-1.5">
            <dt className="text-muted">Tax</dt>
            <dd>{money(res.tax_minor)}</dd>
          </div>
          <div className="flex justify-between gap-6 border-t-2 border-ink py-2 text-base font-semibold">
            <dt>Total</dt>
            <dd>{money(res.total_minor)}</dd>
          </div>
        </dl>
        <p className="mt-8 max-w-prose text-xs text-muted">Prices are those agreed when the nights were booked.</p>
      </main>
    );
  }

  // ---- invoice ---------------------------------------------------------------------------------------------------------
  if (kind === "invoice") {
    const invoice = pickInvoice(invoices)!;
    const { data: lineRows } = await supabase
      .from("invoice_lines")
      .select("id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date")
      .eq("invoice_id", invoice.id)
      .order("service_date")
      .order("id");
    const lines = (lineRows ?? []) as Line[];
    const isVoid = invoice.invoice_status === "void";
    return (
      <main className="max-w-3xl">
        {header}
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <PageTitle>Invoice {invoice.invoice_number}</PageTitle>
            <p className="mt-1 text-sm text-muted">Invoice date {formatDate(invoice.issued_at.slice(0, 10))}</p>
          </div>
          <div className="text-sm sm:text-right">
            <p className="font-medium">{prop.name}</p>
            {prop.address && <p>{prop.address}</p>}
            <p>{[prop.city, prop.state].filter(Boolean).join(", ")}</p>
          </div>
        </div>
        {isVoid && (
          <p role="status" className="mt-4 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">
            <span className="font-semibold">Void.</span> This invoice was withdrawn {formatDateTime(invoice.voided_at, tz)}
            {invoice.void_reason ? `: ${invoice.void_reason}` : "."} It is kept for the record and is not valid.
          </p>
        )}
        {facts}
        <div className="mt-8 overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[32rem] text-sm print:min-w-0">
            <caption className="sr-only">Lines on invoice {invoice.invoice_number}</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className={`${th} pl-0`}>
                  Date
                </th>
                <th scope="col" className={th}>
                  Description
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Price
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Tax
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-line tabular-nums">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {l.service_date ? formatDate(l.service_date) : ""}
                  </th>
                  <td className="px-2 py-2">
                    {l.description}
                    {l.quantity > 1 ? ` x ${l.quantity}` : ""}
                  </td>
                  <td className="px-2 py-2 text-right">{money(l.unit_amount_minor)}</td>
                  <td className="px-2 py-2 text-right">{l.tax_amount_minor > 0 ? money(l.tax_amount_minor) : "–"}</td>
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
          {invoice.discount_minor > 0 && (
            <div className="flex justify-between gap-6 py-1.5">
              <dt className="text-muted">Discount</dt>
              <dd>-{money(invoice.discount_minor)}</dd>
            </div>
          )}
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
          Payments are shown on the receipt. Extras charged during the stay are on their own numbered invoices.
        </p>
      </main>
    );
  }

  // ---- receipt ---------------------------------------------------------------------------------------------------------
  if (kind === "receipt") {
    const t = receiptTotals(payments, refunds);
    return (
      <main className="max-w-3xl">
        {header}
        {letterhead}
        {facts}
        <div className="mt-8 overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[30rem] text-sm print:min-w-0">
            <caption className="sr-only">Payments received for booking {res.booking_reference}</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className={`${th} pl-0`}>
                  Received
                </th>
                <th scope="col" className={th}>
                  Method
                </th>
                <th scope="col" className={th}>
                  Reference
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr
                  key={p.id}
                  className={`border-b border-line tabular-nums ${p.payment_status === "reversed" ? "text-muted line-through" : ""}`}
                >
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {formatDateTime(p.received_at, tz)}
                  </th>
                  <td className="px-2 py-2">
                    {PAYMENT_METHOD_LABEL[p.payment_method] ?? p.payment_method}
                    {p.payment_status === "reversed" ? " (reversed)" : ""}
                  </td>
                  <td className="px-2 py-2">{p.provider_reference ?? p.internal_reference}</td>
                  <td className="px-2 py-2 text-right">{money(p.amount_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto mt-4 max-w-xs text-sm tabular-nums">
          <div className="flex justify-between gap-6 py-1.5">
            <dt className="text-muted">Received</dt>
            <dd>{money(t.received)}</dd>
          </div>
          {t.refunded > 0 && (
            <div className="flex justify-between gap-6 py-1.5">
              <dt className="text-muted">Paid back</dt>
              <dd>-{money(t.refunded)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-6 border-t-2 border-ink py-2 text-base font-semibold">
            <dt>Kept by the hotel</dt>
            <dd>{money(t.kept)}</dd>
          </div>
        </dl>
        {t.pending > 0 && <p className="mt-2 text-right text-xs text-muted">{money(t.pending)} more is being refunded.</p>}
        <p className="mt-8 max-w-prose text-xs text-muted">
          This lists the payments recorded on the booking. It is not a tax receipt unless the hotel&rsquo;s own receipt rules say so.
        </p>
      </main>
    );
  }

  // ---- cancellation confirmation ---------------------------------------------------------------------------------------
  const t = receiptTotals(payments, refunds);
  return (
    <main className="max-w-3xl">
      {header}
      {letterhead}
      {facts}
      <p className="mt-6 text-sm">This booking was cancelled{res.cancelled_at ? ` on ${formatDateTime(res.cancelled_at, tz)}` : ""}.</p>
      <dl className="mt-4 max-w-sm text-sm tabular-nums">
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Booking total</dt>
          <dd>{money(res.total_minor)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Cancellation charge</dt>
          <dd>{money(res.cancellation_charge_minor)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Paid</dt>
          <dd>{money(t.received)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Paid back so far</dt>
          <dd>{money(t.refunded)}</dd>
        </div>
      </dl>
      {refunds.length > 0 && (
        <table className="mt-4 w-full max-w-md text-sm tabular-nums">
          <caption className="sr-only">Refunds on this booking</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className={`${th} pl-0`}>
                Asked for
              </th>
              <th scope="col" className={th}>
                Status
              </th>
              <th scope="col" className={`${th} text-right`}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {refunds.map((r) => (
              <tr key={r.id} className="border-b border-line">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {formatDate(r.created_at.slice(0, 10))}
                </th>
                <td className="px-2 py-2">{REFUND_STATUS_LABEL[r.refund_status] ?? r.refund_status}</td>
                <td className="px-2 py-2 text-right">{money(r.amount_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-8 max-w-prose text-xs text-muted">
        The cancellation charge is the amount the hotel&rsquo;s policy set when the booking was cancelled.
      </p>
    </main>
  );
}
