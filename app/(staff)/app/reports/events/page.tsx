import Link from "next/link";
import { PrintButton } from "@/components/staff/print-button";
import { PrintHeader } from "@/components/staff/print-header";
import {
  buttonPrimary,
  EmptyState,
  headRow,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  StatTile,
  tdNum,
  thNum,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { rememberedProperty } from "@/lib/staff/active-property";
import { BOOKING_STATUS_LABEL, EVENT_STATUS_LABEL, formatLocal } from "@/lib/staff/events";
import { pickProperty } from "@/lib/staff/property-choice";
import { MAX_RANGE_DAYS, parseRange, presets } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Search = Record<string, string | string[] | undefined>;
type Report = {
  by_status: Record<string, number>;
  booked: {
    bookings: number;
    subtotal_minor: number;
    service_minor: number;
    tax_minor: number;
    total_minor: number;
    received_minor: number;
    outstanding_minor: number;
  };
  venues: { venue_id: string; name: string; bookings: number; hours: number; total_minor: number; received_minor: number }[];
  events: {
    event_id: string;
    title: string;
    status: string;
    starts_at: string;
    capacity: number;
    sold: number;
    checked_in: number;
    revenue_minor: number;
    refund_due_minor: number;
  }[];
};

/** Venue hire and ticket sales for a date range. Needs report.view and event.view; the database decides. */
export default async function EventReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name, timezone, currency").eq("status", "active").order("name");
  const all = (props ?? []) as { id: string; name: string; timezone: string; currency: string }[];
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const [a, b] = await Promise.all([
          supabase.rpc("has_permission", { p_property: p.id, p_permission: "report.view" }),
          supabase.rpc("has_permission", { p_property: p.id, p_permission: "event.view" }),
        ]);
        return a.data === true && b.data === true ? p : null;
      }),
    )
  ).filter((p): p is (typeof all)[number] => p !== null);
  if (allowed.length === 0) {
    return (
      <main className="max-w-2xl">
        <PageTitle>Events report</PageTitle>
        <EmptyState className="mt-4">You do not have permission to see this report.</EmptyState>
      </main>
    );
  }
  const chosen = pickProperty(allowed, typeof search.property === "string" ? search.property : undefined, await rememberedProperty())!;
  const today = todayIn(chosen.timezone, new Date());
  const range = parseRange(search.from, search.to, today);
  const { data, error } = await supabase.rpc("event_report", { p_property: chosen.id, p_from: range.from, p_to: range.to });
  const r = error ? null : (data as unknown as Report);
  const money = (n: number) => formatMoney(n, chosen.currency);
  const qs = (from: string, to: string) => `?${new URLSearchParams({ property: chosen.id, from, to })}`;

  return (
    <main>
      <p className="text-sm print:hidden">
        <Link href="/app/reports" className={linkClass}>
          Money and revenue report
        </Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/app/events?property=${chosen.id}`} className={linkClass}>
          Events
        </Link>
      </p>
      <PageTitle className="mt-2">Events report</PageTitle>
      <PrintHeader hotel={chosen.name} from={range.from} to={range.to} />
      <PageIntro>
        Venue hire counts bookings that start in the range; ticket sales count events that start in it. Money is what has been received,
        less refunds.
      </PageIntro>
      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 print:hidden">
        {allowed.length > 1 && (
          <div>
            <label htmlFor="property" className="block text-sm">
              Property
            </label>
            <select id="property" name="property" defaultValue={chosen.id} className={inputClass}>
              {allowed.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="from" className="block text-sm">
            From
          </label>
          <input id="from" name="from" type="date" required defaultValue={range.from} className={inputClass} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">
            To
          </label>
          <input id="to" name="to" type="date" required defaultValue={range.to} className={inputClass} />
        </div>
        <PendingButton className={buttonPrimary} pendingLabel="Loading…">
          Show
        </PendingButton>
        <PrintButton />
      </form>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm print:hidden">
        {presets(today).map((p) => (
          <Link key={p.label} href={qs(p.from, p.to)} className={linkClass}>
            {p.label}
          </Link>
        ))}
      </p>
      {range.trimmed && (
        <p role="status" className="mt-3 text-sm text-pending">
          That range is longer than {MAX_RANGE_DAYS} days, so the most recent {MAX_RANGE_DAYS} days are shown.
        </p>
      )}

      {!r ? (
        <p role="alert" className="mt-6 rounded border border-critical/40 bg-white p-3 text-critical">
          The report could not be loaded. Try again, or choose a shorter range.
        </p>
      ) : (
        <>
          <h2 className="mt-8 font-display text-xl">Venue hire</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <StatTile label="Confirmed bookings" value={String(r.booked.bookings)} note="confirmed and completed" />
            <StatTile
              label="Booked value"
              value={money(r.booked.total_minor)}
              note={`${money(r.booked.service_minor)} service, ${money(r.booked.tax_minor)} tax`}
            />
            <StatTile label="Received" value={money(r.booked.received_minor)} note="less refunds" />
            <StatTile label="Still owed" value={money(r.booked.outstanding_minor)} note="on confirmed bookings" />
          </div>
          <p className="mt-3 text-sm text-muted">
            {Object.entries(r.by_status)
              .map(([s, n]) => `${BOOKING_STATUS_LABEL[s] ?? s}: ${n}`)
              .join(" · ") || "No bookings in this range."}
          </p>
          {r.venues.length > 0 && (
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th className="py-2 pr-3 font-normal">Venue</th>
                  <th className={thNum}>Bookings</th>
                  <th className={thNum}>Hours</th>
                  <th className={thNum}>Value</th>
                  <th className={thNum}>Received</th>
                </tr>
              </thead>
              <tbody>
                {r.venues.map((v) => (
                  <tr key={v.venue_id} className="border-b border-line">
                    <td className="py-2 pr-3">{v.name}</td>
                    <td className={tdNum}>{v.bookings}</td>
                    <td className={tdNum}>{v.hours}</td>
                    <td className={tdNum}>{money(v.total_minor)}</td>
                    <td className={tdNum}>{money(v.received_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 className="mt-10 font-display text-xl">Ticketed events</h2>
          {r.events.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No ticketed events start in this range.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th className="py-2 pr-3 font-normal">Event</th>
                  <th className="px-2 py-2 font-normal">Status</th>
                  <th className={thNum}>Sold</th>
                  <th className={thNum}>Checked in</th>
                  <th className={thNum}>Received</th>
                  <th className={thNum}>To refund</th>
                </tr>
              </thead>
              <tbody>
                {r.events.map((e) => (
                  <tr key={e.event_id} className="border-b border-line">
                    <td className="py-2 pr-3">
                      <Link href={`/app/events/tickets/${e.event_id}`} className={linkClass}>
                        {e.title}
                      </Link>
                      <div className="text-xs text-muted">{formatLocal(e.starts_at)}</div>
                    </td>
                    <td className="px-2 py-2">{EVENT_STATUS_LABEL[e.status] ?? e.status}</td>
                    <td className={tdNum}>
                      {e.sold} of {e.capacity}
                    </td>
                    <td className={tdNum}>{e.checked_in}</td>
                    <td className={tdNum}>{money(e.revenue_minor)}</td>
                    <td className={tdNum}>{e.refund_due_minor ? money(e.refund_due_minor) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
