import Link from "next/link";
import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, inputClass, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import {
  countLabel,
  filterZone,
  formatDay,
  MONEY_PAGE_SIZE,
  parseSummary,
  summaryWindow,
  windowLabel,
  PAYMENT_SOURCE_FILTERS,
  PAYMENT_STATUS_FILTERS,
  parsePaymentFilters,
  paymentFiltersActive,
  paymentMethodLabel,
  paymentQuery,
  paymentSourceLabel,
  paymentStatusColumns,
  receivedTotals,
  startOfDayIso,
  startOfNextDayIso,
  verificationLabel,
} from "@/lib/staff/money-lists";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

const COLUMNS =
  "id, property_id, reservation_id, payment_provider, payment_method, provider_reference, internal_reference, amount_minor, currency, payment_status, verification_status, received_at";

type Row = {
  id: string;
  property_id: string;
  reservation_id: string;
  payment_provider: string;
  payment_method: string;
  provider_reference: string | null;
  internal_reference: string;
  amount_minor: number;
  currency: string;
  payment_status: string;
  verification_status: string;
  received_at: string;
};

export default async function AllPaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const f = parsePaymentFilters(await searchParams);
  const supabase = await createClient();

  // Row level security limits every read here to hotels where the person may see money.
  const propQ = await supabase.from("properties").select("id, name, timezone");
  const props = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const zones = new Map(props.map((p) => [p.id, p.timezone]));
  const names = new Map(props.map((p) => [p.id, p.name]));
  const { zone, mixed } = filterZone(props.map((p) => p.timezone));

  // The money position is read in the same dates as the list. "Received" and "Refunded" follow the dates; the two waiting tiles are
  // the position right now. Row level security limits it to what this person may see, so someone who may see no money gets nothing.
  const win = summaryWindow(f, zone);
  const summaryQ = await supabase.rpc("payments_summary", { p_from: win.from ?? undefined, p_to: win.to ?? undefined });
  const summary = summaryQ.error ? null : parseSummary(summaryQ.data);
  const dateNote = windowLabel(f, formatDay);

  let query = supabase.from("payments").select(COLUMNS, { count: "exact" });
  if (f.source !== "all") query = query.eq("payment_provider", f.source);
  const cols = paymentStatusColumns(f.status);
  if (cols.payment_status) query = query.eq("payment_status", cols.payment_status);
  if (cols.verification_status) query = query.eq("verification_status", cols.verification_status);
  if (f.from) query = query.gte("received_at", startOfDayIso(f.from, zone));
  if (f.to) query = query.lt("received_at", startOfNextDayIso(f.to, zone));

  if (f.q) {
    // A search matches a payment's own references, or the booking it belongs to (by reference or guest).
    // Guest names need guest.view; without it RLS returns no guests and only references match.
    const [resQ, guestQ] = await Promise.all([
      supabase.from("reservations").select("id").ilike("booking_reference", `%${f.q}%`).limit(50),
      supabase.from("guests").select("id").or(`full_name.ilike.%${f.q}%,email.ilike.%${f.q}%,phone.ilike.%${f.q}%`).limit(50),
    ]);
    const guestIds = ((guestQ.data ?? []) as { id: string }[]).map((g) => g.id);
    const byGuest = guestIds.length
      ? ((await supabase.from("reservations").select("id").in("primary_guest_id", guestIds).limit(100)).data ?? [])
      : [];
    const resIds = [...new Set([...((resQ.data ?? []) as { id: string }[]), ...(byGuest as { id: string }[])].map((r) => r.id))];
    query = query.or(
      [
        `internal_reference.ilike.%${f.q}%`,
        `provider_reference.ilike.%${f.q}%`,
        ...(resIds.length ? [`reservation_id.in.(${resIds.join(",")})`] : []),
      ].join(","),
    );
  }

  const offset = (f.page - 1) * MONEY_PAGE_SIZE;
  const { data, error, count } = await query
    .order("received_at", { ascending: false })
    .order("id")
    .range(offset, offset + MONEY_PAGE_SIZE - 1);
  const rows = (data ?? []) as Row[];

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

  const total = count ?? 0;
  const pages = Math.max(Math.ceil(total / MONEY_PAGE_SIZE), 1);
  const showProperty = props.length > 1;
  const pageTotals = [...receivedTotals(rows)];
  const tab = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-navy-900 text-white" : "bg-ink/5 text-ink hover:bg-ink/10"} focus-visible:outline-2 focus-visible:outline-primary`;

  return (
    <main className="max-w-5xl">
      <PageTitle>Payments</PageTitle>
      <PageIntro>
        Every payment taken for a booking, whether the desk recorded it or the guest paid online. Open one to see which booking it belongs
        to and which invoice it was applied to.
      </PageIntro>

      <div className="mt-6 flex flex-wrap items-center gap-2" role="navigation" aria-label="Payments screens">
        <Link href="/app/payments" className={tab(false)}>
          To verify
        </Link>
        <Link href="/app/payments/all" className={tab(true)} aria-current="page">
          All payments
        </Link>
      </div>

      {summary && (
        <section
          aria-label="Money position"
          className="mt-4 grid gap-x-6 gap-y-4 rounded border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Tile title="Received" note={dateNote} rows={summary.received} noun="payment" />
          <Tile
            title="Waiting to be verified"
            note="Right now"
            rows={summary.unverified}
            noun="payment"
            href="/app/payments"
            linkText="Verify them"
          />
          <Tile
            title="Refunds in progress"
            note="Right now"
            rows={summary.refunds_open}
            noun="refund"
            href="/app/refunds"
            linkText="Open refunds"
          />
          <Tile title="Refunded" note={dateNote} rows={summary.refunded} noun="refund" />
        </section>
      )}
      {summary && <p className="mt-1 text-xs text-muted">Received is money taken before any refund. Refunds are counted separately.</p>}

      <form
        method="get"
        className="mt-4 grid gap-3 rounded border border-line bg-white p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end"
      >
        <div>
          <label htmlFor="q" className="block text-sm">
            Reference or guest
          </label>
          <input id="q" name="q" defaultValue={f.q} maxLength={60} placeholder="Booking, receipt or guest" className={inputClass} />
        </div>
        <div>
          <label htmlFor="source" className="block text-sm">
            Taken
          </label>
          <select id="source" name="source" defaultValue={f.source} className={inputClass}>
            {PAYMENT_SOURCE_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="status" className="block text-sm">
            Status
          </label>
          <select id="status" name="status" defaultValue={f.status} className={inputClass}>
            {PAYMENT_STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="block text-sm">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={f.from ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">
            To
          </label>
          <input id="to" name="to" type="date" defaultValue={f.to ?? ""} className={inputClass} />
        </div>
        <div className="flex gap-2">
          <PendingButton className={buttonPrimary} pendingLabel="Searching…">
            Search
          </PendingButton>
          {paymentFiltersActive(f) && (
            <Link href="/app/payments/all" className={buttonQuiet}>
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
          The payments could not be loaded. You may not have permission to see payments. Reload the page.
        </ErrorBanner>
      )}

      {!error && rows.length === 0 && (
        <EmptyState className="mt-6">
          {paymentFiltersActive(f) ? "No payments match. Try a different search or clear the filters." : "No payments have been taken yet."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <>
          <p className="mt-6 text-sm text-muted" aria-live="polite">
            {total} {total === 1 ? "payment" : "payments"}
            {pages > 1 ? `, page ${f.page} of ${pages}` : ""}
            {pageTotals.length > 0 && (
              <>. Received on this page: {pageTotals.map(([cur, minor]) => formatMoney(minor, cur)).join(" and ")}</>
            )}
          </p>
          <ul className="mt-2 border-t border-line">
            {rows.map((p) => {
              const res = reservations.get(p.reservation_id);
              const tz = zones.get(p.property_id) ?? "UTC";
              const reversed = p.payment_status === "reversed";
              return (
                <li key={p.id} className="border-b border-line">
                  <Link
                    href={`/app/payments/${p.id}`}
                    className="grid gap-x-8 gap-y-2 py-4 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary md:grid-cols-[minmax(0,1fr)_11rem_9rem]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium">{res?.booking_reference ?? "Booking"}</span>
                        <span className="text-sm">{paymentMethodLabel(p.payment_method)}</span>
                        {reversed && <span className="rounded bg-critical/10 px-2 py-0.5 text-xs font-medium text-critical">Reversed</span>}
                        {!reversed && p.verification_status === "unverified" && (
                          <span className="rounded bg-pending/10 px-2 py-0.5 text-xs font-medium text-pending">
                            {verificationLabel("unverified")}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm">
                        {res ? (guests.get(res.primary_guest_id) ?? <span className="text-muted">Guest not visible to you</span>) : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {[
                          paymentSourceLabel(p.payment_provider),
                          p.provider_reference ? `ref ${p.provider_reference}` : null,
                          showProperty ? names.get(p.property_id) : null,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    </div>
                    <p className="text-sm md:text-right">{formatDateTime(p.received_at, tz)}</p>
                    <p className={`font-semibold tabular-nums md:text-right ${reversed ? "text-muted line-through" : ""}`}>
                      {formatMoney(p.amount_minor, p.currency)}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>

          {pages > 1 && (
            <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-sm">
              {f.page > 1 ? (
                <Link href={`/app/payments/all${paymentQuery(f, { page: f.page - 1 })}`} className={buttonQuiet} rel="prev">
                  Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted">
                Page {f.page} of {pages}
              </span>
              {f.page < pages ? (
                <Link href={`/app/payments/all${paymentQuery(f, { page: f.page + 1 })}`} className={buttonQuiet} rel="next">
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

/** One figure in the money position: a title, the dates it covers, and an amount per currency (never added across currencies). */
function Tile({
  title,
  note,
  rows,
  noun,
  href,
  linkText,
}: {
  title: string;
  note: string;
  rows: { currency: string; amount_minor: number; count: number }[];
  noun: "payment" | "refund";
  href?: string;
  linkText?: string;
}) {
  return (
    <div>
      <h2 className="text-sm text-muted">{title}</h2>
      <p className="text-xs text-muted">{note}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-lg">None</p>
      ) : (
        <ul className="mt-1">
          {rows.map((r) => (
            <li key={r.currency}>
              <span className="text-lg font-semibold tabular-nums">{formatMoney(r.amount_minor, r.currency)}</span>
              <span className="ml-2 text-xs text-muted">{countLabel(r.count, noun)}</span>
            </li>
          ))}
        </ul>
      )}
      {href && rows.length > 0 && (
        <p className="mt-1 text-sm">
          <Link href={href} className="text-primary-strong underline underline-offset-2">
            {linkText}
          </Link>
        </p>
      )}
    </div>
  );
}
