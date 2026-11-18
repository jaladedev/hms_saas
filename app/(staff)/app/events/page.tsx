import Link from "next/link";
import { buttonPrimary, EmptyState, ErrorBanner, headRow, linkClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { eventProperties, netPaid } from "@/lib/staff/event-page-helpers";
import { BOOKING_STATUS_LABEL, bookingNeed, EVENT_TYPE_LABEL, formatLocal, type BookingRow } from "@/lib/staff/events";

export const dynamic = "force-dynamic";
type Search = Record<string, string | string[] | undefined>;
const FILTERS = ["open", "enquiry", "tentative", "confirmed", "past"] as const;
const FILTER_LABEL: Record<string, string> = { open: "Needs action", enquiry: "Enquiries", tentative: "On hold", confirmed: "Confirmed", past: "Past and closed" };

/** Venue hire: enquiries, held slots and confirmed bookings for one hotel, soonest first. */
export default async function EventBookingsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const { supabase, chosen } = await eventProperties("event.view", typeof search.property === "string" ? search.property : undefined);
  if (!chosen) {
    return (
      <main className="max-w-2xl">
        <PageTitle>Events</PageTitle>
        <EmptyState className="mt-4">You do not have permission to see events.</EmptyState>
      </main>
    );
  }
  const filter = (FILTERS as readonly string[]).includes(String(search.show)) ? String(search.show) : "open";
  let q = supabase
    .from("venue_bookings")
    .select("*")
    .eq("property_id", chosen.id)
    .neq("source", "ticketed_event")
    .order("starts_at", { ascending: filter === "past" ? false : true })
    .limit(200);
  if (filter === "open") q = q.in("status", ["enquiry", "tentative"]);
  else if (filter === "enquiry" || filter === "tentative" || filter === "confirmed") q = q.eq("status", filter);
  else q = q.in("status", ["completed", "cancelled", "expired", "declined"]);
  const [bookQ, venueQ, mayManage] = await Promise.all([
    q,
    supabase.from("hotel_venues").select("id, name").eq("property_id", chosen.id),
    supabase.rpc("has_permission", { p_property: chosen.id, p_permission: "event.manage" }),
  ]);
  const rows = (bookQ.data ?? []) as BookingRow[];
  const venueName = new Map(((venueQ.data ?? []) as { id: string; name: string }[]).map((v) => [v.id, v.name]));
  const ids = rows.map((r) => r.id);
  const payQ = ids.length ? await supabase.from("event_payments").select("venue_booking_id, payment_kind, amount_minor").in("venue_booking_id", ids) : { data: [] };
  const paidBy = new Map<string, number>();
  for (const p of (payQ.data ?? []) as { venue_booking_id: string; payment_kind: string; amount_minor: number }[]) {
    paidBy.set(p.venue_booking_id, netPaid([p]) + (paidBy.get(p.venue_booking_id) ?? 0));
  }
  const qs = (extra: Record<string, string>) => `?${new URLSearchParams({ property: chosen.id, ...extra })}`;

  return (
    <main>
      <PageTitle>Events</PageTitle>
      <p className="text-sm">
        <span className="font-medium">Venue hire</span>
        <span aria-hidden="true"> · </span>
        <Link href={`/app/events/tickets${qs({})}`} className={linkClass}>
          Ticketed events
        </Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/app/reports/events${qs({})}`} className={linkClass}>
          Report
        </Link>
      </p>
      <PageIntro>Halls and meeting rooms hired for weddings, conferences and parties. A held slot keeps the date for the client until its hold ends.</PageIntro>
      <div className="mt-4">
        <Notice search={search} currency={chosen.currency} />
      </div>
      {(bookQ.error || venueQ.error) && <ErrorBanner className="mb-4">The bookings could not be loaded. Reload the page.</ErrorBanner>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f} href={`/app/events${qs({ show: f })}`} className={f === filter ? "font-semibold underline" : linkClass}>
            {FILTER_LABEL[f]}
          </Link>
        ))}
        {mayManage.data === true && (
          <Link href={`/app/events/new${qs({})}`} className={`${buttonPrimary} ml-auto`}>
            New booking
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState className="mt-4">Nothing here.</EmptyState>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={headRow}>
                <th className="py-2 pr-3 font-normal">Reference</th>
                <th className="px-2 py-2 font-normal">When</th>
                <th className="px-2 py-2 font-normal">Venue</th>
                <th className="px-2 py-2 font-normal">Client</th>
                <th className="px-2 py-2 font-normal">Status</th>
                <th className="px-2 py-2 text-right font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const need = bookingNeed(b, paidBy.get(b.id) ?? 0);
                return (
                  <tr key={b.id} className="border-b border-line align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/app/events/${b.id}`} className={linkClass}>
                        {b.reference}
                      </Link>
                      <div className="text-xs text-muted">{b.title || EVENT_TYPE_LABEL[b.event_type] || b.event_type}</div>
                    </td>
                    <td className="px-2 py-2">{formatLocal(b.starts_at)}</td>
                    <td className="px-2 py-2">{venueName.get(b.venue_id) ?? "–"}</td>
                    <td className="px-2 py-2">{b.contact_name}</td>
                    <td className="px-2 py-2">
                      {BOOKING_STATUS_LABEL[b.status] ?? b.status}
                      {b.attention_reason && <span className="ml-1 text-xs font-medium text-red-700">Needs attention</span>}
                      {need && <div className="text-xs text-muted">{need}</div>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{b.total_minor ? formatMoney(b.total_minor, b.currency) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
