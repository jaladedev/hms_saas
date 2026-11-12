import Link from "next/link";
import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, inputClass, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import {
  filterZone,
  INVOICE_KIND_FILTERS,
  INVOICE_STATUS_FILTERS,
  invoiceBalanceMinor,
  invoiceFiltersActive,
  invoiceQuery,
  invoiceStatusLabel,
  isOverdue,
  moneyHeldByReservation,
  MONEY_PAGE_SIZE,
  parseInvoiceFilters,
  startOfDayIso,
  startOfNextDayIso,
} from "@/lib/staff/money-lists";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  property_id: string;
  reservation_id: string;
  invoice_number: string;
  invoice_status: string;
  currency: string;
  total_minor: number;
  issued_at: string;
  due_at?: string | null;
};

const STATUS_CHIP: Record<string, string> = {
  issued: "bg-ink/10 text-muted",
  partially_paid: "bg-pending/10 text-pending",
  paid: "bg-primary/10 text-primary-strong",
  void: "bg-critical/10 text-critical",
};

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parseInvoiceFilters(await searchParams);
  const supabase = await createClient();

  const propQ = await supabase.from("properties").select("id, name, timezone");
  const props = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const zones = new Map(props.map((p) => [p.id, p.timezone]));
  const names = new Map(props.map((p) => [p.id, p.name]));
  const { zone, mixed } = filterZone(props.map((p) => p.timezone));

  // Booking invoices and invoices for extras live in two tables. Row level security limits both to people who may see money.
  const table = f.kind === "extras" ? "folio_invoices" : "invoices";
  const columns =
    f.kind === "extras"
      ? "id, property_id, reservation_id, invoice_number, invoice_status, currency, total_minor, issued_at"
      : "id, property_id, reservation_id, invoice_number, invoice_status, currency, total_minor, issued_at, due_at";
  let query = supabase.from(table).select(columns, { count: "exact" });
  if (f.status !== "all") query = query.eq("invoice_status", f.status);
  if (f.from) query = query.gte("issued_at", startOfDayIso(f.from, zone));
  if (f.to) query = query.lt("issued_at", startOfNextDayIso(f.to, zone));

  if (f.q) {
    // An invoice number, a booking reference, or (with guest.view) a guest's name.
    const [resQ, guestQ] = await Promise.all([
      supabase.from("reservations").select("id").ilike("booking_reference", `%${f.q}%`).limit(50),
      supabase.from("guests").select("id").or(`full_name.ilike.%${f.q}%,email.ilike.%${f.q}%,phone.ilike.%${f.q}%`).limit(50),
    ]);
    const guestIds = ((guestQ.data ?? []) as { id: string }[]).map((g) => g.id);
    const byGuest = guestIds.length
      ? ((await supabase.from("reservations").select("id").in("primary_guest_id", guestIds).limit(100)).data ?? [])
      : [];
    const resIds = [...new Set([...((resQ.data ?? []) as { id: string }[]), ...(byGuest as { id: string }[])].map((r) => r.id))];
    query = query.or([`invoice_number.ilike.%${f.q}%`, ...(resIds.length ? [`reservation_id.in.(${resIds.join(",")})`] : [])].join(","));
  }

  const offset = (f.page - 1) * MONEY_PAGE_SIZE;
  const { data, error, count } = await query
    .order("issued_at", { ascending: false })
    .order("id")
    .range(offset, offset + MONEY_PAGE_SIZE - 1);
  const rows = (data ?? []) as unknown as Row[];

  const resIds = [...new Set(rows.map((r) => r.reservation_id))];
  const resQ = resIds.length
    ? await supabase.from("reservations").select("id, booking_reference, primary_guest_id").in("id", resIds)
    : { data: [] };
  const reservations = new Map(
    ((resQ.data ?? []) as { id: string; booking_reference: string; primary_guest_id: string }[]).map((r) => [r.id, r]),
  );
  const guestIds = [...new Set([...reservations.values()].map((r) => r.primary_guest_id))];
  const guestQ = guestIds.length ? await supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] };
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));

  // What is still owed, for booking invoices only (an invoice for extras is settled on the folio). Payment and refund rows are read
  // under the viewer's own permissions, so a role that cannot see them gets no balance rather than a wrong one.
  const bookingIds = f.kind === "extras" ? [] : resIds;
  const [payQ, refQ] = bookingIds.length
    ? await Promise.all([
        supabase.from("payments").select("reservation_id, amount_minor, payment_status").in("reservation_id", bookingIds),
        supabase.from("refunds").select("reservation_id, amount_minor, refund_status").in("reservation_id", bookingIds),
      ])
    : [null, null];
  const canSeeBalance = f.kind !== "extras" && !!payQ && !payQ.error && !!refQ && !refQ.error;
  const held = canSeeBalance
    ? moneyHeldByReservation(
        (payQ!.data ?? []) as { reservation_id: string; amount_minor: number; payment_status: string }[],
        (refQ!.data ?? []) as { reservation_id: string; amount_minor: number; refund_status: string }[],
      )
    : new Map<string, number>();

  const total = count ?? 0;
  const pages = Math.max(Math.ceil(total / MONEY_PAGE_SIZE), 1);
  const showProperty = props.length > 1;
  const now = new Date();
  const tab = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-navy-900 text-white" : "bg-ink/5 text-ink hover:bg-ink/10"} focus-visible:outline-2 focus-visible:outline-primary`;
  const linkFor = (r: Row) =>
    f.kind === "extras" ? `/app/reservations/${r.reservation_id}/folio-invoice/${r.id}` : `/app/reservations/${r.reservation_id}/documents`;

  return (
    <main className="max-w-5xl">
      <PageTitle>Invoices</PageTitle>
      <PageIntro>
        Every invoice the hotel has issued. Booking invoices cover the room charges and are marked paid as payments are applied. An invoice
        for extras is a numbered copy of the extras posted to a stay.
      </PageIntro>

      <div className="mt-6 flex flex-wrap items-center gap-2" role="navigation" aria-label="Which invoices">
        {INVOICE_KIND_FILTERS.map((k) => (
          <Link
            key={k.value}
            href={`/app/invoices${invoiceQuery({ ...f, status: "all", page: 1 }, { kind: k.value })}`}
            className={tab(f.kind === k.value)}
            aria-current={f.kind === k.value ? "page" : undefined}
          >
            {k.label}
          </Link>
        ))}
      </div>

      <form
        method="get"
        className="mt-4 grid gap-3 rounded border border-line bg-white p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
      >
        {f.kind === "extras" && <input type="hidden" name="kind" value="extras" />}
        <div>
          <label htmlFor="q" className="block text-sm">
            Invoice, booking or guest
          </label>
          <input id="q" name="q" defaultValue={f.q} maxLength={60} placeholder="Invoice number, booking or guest" className={inputClass} />
        </div>
        <div>
          <label htmlFor="status" className="block text-sm">
            Status
          </label>
          <select id="status" name="status" defaultValue={f.status} className={inputClass}>
            {INVOICE_STATUS_FILTERS[f.kind].map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="block text-sm">
            Issued from
          </label>
          <input id="from" name="from" type="date" defaultValue={f.from ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">
            Issued to
          </label>
          <input id="to" name="to" type="date" defaultValue={f.to ?? ""} className={inputClass} />
        </div>
        <div className="flex gap-2">
          <PendingButton className={buttonPrimary} pendingLabel="Searching…">
            Search
          </PendingButton>
          {invoiceFiltersActive(f) && (
            <Link href="/app/invoices" className={buttonQuiet}>
              Clear
            </Link>
          )}
        </div>
      </form>
      {mixed && (f.from || f.to) && (
        <p className="mt-2 text-xs text-muted">Your hotels are in different time zones, so the dates above are counted in UTC.</p>
      )}

      {(error || propQ.error) && (
        <ErrorBanner className="mt-6">
          The invoices could not be loaded. You may not have permission to see invoices. Reload the page.
        </ErrorBanner>
      )}

      {!error && rows.length === 0 && (
        <EmptyState className="mt-6">
          {invoiceFiltersActive(f)
            ? "No invoices match. Try a different search or clear the filters."
            : "No invoices have been issued yet."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <>
          <p className="mt-6 text-sm text-muted" aria-live="polite">
            {total} {total === 1 ? "invoice" : "invoices"}
            {pages > 1 ? `, page ${f.page} of ${pages}` : ""}
          </p>
          <ul className="mt-2 border-t border-line">
            {rows.map((r) => {
              const res = reservations.get(r.reservation_id);
              const tz = zones.get(r.property_id) ?? "UTC";
              const overdue = isOverdue({ invoice_status: r.invoice_status, due_at: r.due_at ?? null }, now);
              return (
                <li key={r.id} className="border-b border-line">
                  <Link
                    href={linkFor(r)}
                    className="grid gap-x-8 gap-y-2 py-4 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary md:grid-cols-[minmax(0,1fr)_12rem_9rem_9rem]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">{r.invoice_number}</span>
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[r.invoice_status] ?? "bg-ink/10 text-muted"}`}
                        >
                          {invoiceStatusLabel(r.invoice_status)}
                        </span>
                        {overdue && <span className="rounded bg-critical/10 px-2 py-0.5 text-xs font-medium text-critical">Overdue</span>}
                      </div>
                      <p className="mt-1 text-sm">
                        {res ? (guests.get(res.primary_guest_id) ?? <span className="text-muted">Guest not visible to you</span>) : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {[res?.booking_reference, showProperty ? names.get(r.property_id) : null].filter(Boolean).join(", ")}
                      </p>
                    </div>
                    <p className="text-sm md:text-right">
                      Issued {formatDateTime(r.issued_at, tz)}
                      {r.due_at && <span className="block text-xs text-muted">Due {formatDateTime(r.due_at, tz)}</span>}
                    </p>
                    <p
                      className={`font-semibold tabular-nums md:text-right ${r.invoice_status === "void" ? "text-muted line-through" : ""}`}
                    >
                      {formatMoney(r.total_minor, r.currency)}
                    </p>
                    <p className="text-sm tabular-nums md:text-right">
                      {canSeeBalance
                        ? (() => {
                            const owed = invoiceBalanceMinor(r.invoice_status, r.total_minor, held.get(r.reservation_id) ?? 0);
                            return owed > 0 ? (
                              <>
                                <span className="font-medium">{formatMoney(owed, r.currency)}</span>
                                <span className="block text-xs text-muted">owing</span>
                              </>
                            ) : (
                              <span className="text-muted">{r.invoice_status === "void" ? "Void" : "Settled"}</span>
                            );
                          })()
                        : null}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>

          {pages > 1 && (
            <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-sm">
              {f.page > 1 ? (
                <Link href={`/app/invoices${invoiceQuery(f, { page: f.page - 1 })}`} className={buttonQuiet} rel="prev">
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted">
                Page {f.page} of {pages}
              </span>
              {f.page < pages ? (
                <Link href={`/app/invoices${invoiceQuery(f, { page: f.page + 1 })}`} className={buttonQuiet} rel="next">
                  Next
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </main>
  );
}
