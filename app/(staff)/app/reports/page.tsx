import Link from "next/link";
import { PrintButton } from "@/components/staff/print-button";
import { PrintHeader } from "@/components/staff/print-header";
import { buttonPrimary, inputClass, linkClass, ErrorBanner, PageIntro } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { dayOccupancy, parseRange, totals, type ReportDay } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const CUR = "NGN";
const money = (m: number) => formatMoney(m, CUR);

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, timezone").order("name");
  const all = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  // Only hotels this person may report on; the database checks again on every read.
  const allowed = (await Promise.all(all.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "report.view" });
    return data === true ? p : null;
  }))).filter((p): p is { id: string; name: string; timezone: string } => p !== null);

  const heading = <h1 className="font-display text-3xl">Reports</h1>;
  if (propQ.error) return <main className="max-w-5xl">{heading}<ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner></main>;
  const property = allowed.find((p) => p.id === first(search.property)) ?? allowed[0];
  if (!property) return <main className="max-w-5xl">{heading}<p className="mt-4 max-w-prose text-muted">Reports are for the owner, general manager and accountant. Ask one of them if you need a figure.</p></main>;

  const range = parseRange(first(search.from), first(search.to), todayIn(property.timezone, new Date()));
  const { data, error } = await supabase.rpc("daily_report", { p_property: property.id, p_from: range.from, p_to: range.to });
  const rows = (data ?? []) as ReportDay[];
  const t = totals(rows);
  const csvHref = `/api/staff/reports?property=${property.id}&from=${range.from}&to=${range.to}`;
  const { data: mayExport } = await supabase.rpc("has_permission", { p_property: property.id, p_permission: "report.export" });

  return (
    <main className="max-w-5xl">
      {heading}
      <PrintHeader hotel={property.name} from={range.from} to={range.to} />
      <p className="mt-2 text-sm print:hidden">
        <Link href={`/app/reports/occupancy?${new URLSearchParams({ property: property.id })}`} className={linkClass}>Occupancy</Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/app/reports/channels?${new URLSearchParams({ property: property.id })}`} className={linkClass}>Channels and guests</Link>
      </p>
      <PageIntro>Nights sold, what the hotel earned and what it received, day by day. Amounts are in naira. Cancelled, pending and no-show stays are not counted as sold.</PageIntro>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-4 print:hidden">
        {allowed.length > 1 && (
          <label className="text-sm">Hotel
            <select name="property" defaultValue={property.id} className={`${inputClass} mt-1 block`}>
              {allowed.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-sm">From<input type="date" name="from" defaultValue={range.from} className={`${inputClass} mt-1 block`} /></label>
        <label className="text-sm">To<input type="date" name="to" defaultValue={range.to} className={`${inputClass} mt-1 block`} /></label>
        <button type="submit" className={buttonPrimary}>Show</button>
        <PrintButton />
      </form>
      {range.trimmed && <p role="status" className="mt-3 text-sm text-muted">Showing the most recent 92 days of the range you asked for.</p>}

      {error ? (
        <ErrorBanner className="mt-6">The report could not be loaded. Try again.</ErrorBanner>
      ) : (
        <>
          <section aria-label="Totals" className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="border-l-4 border-primary/40 bg-white px-4 py-3">
              <h2 className="text-sm text-muted">Earned, before tax</h2>
              <p className="font-display text-2xl tabular-nums">{money(t.earned)}</p>
              <p className="text-sm text-muted">Rooms {money(t.roomRevenue)}, extras {money(t.extras)}</p>
            </div>
            <div className="border-l-4 border-primary/40 bg-white px-4 py-3">
              <h2 className="text-sm text-muted">Received, less refunds</h2>
              <p className="font-display text-2xl tabular-nums">{money(t.cashNet)}</p>
              <p className="text-sm text-muted">Received {money(t.cashIn)}, refunded {money(t.refundsPaid)}</p>
            </div>
            <div className="border-l-4 border-primary/40 bg-white px-4 py-3">
              <h2 className="text-sm text-muted">Occupancy</h2>
              <p className="font-display text-2xl tabular-nums">{t.occupancyPercent === null ? "None" : `${t.occupancyPercent}%`}</p>
              <p className="text-sm text-muted">{t.roomNights} of {t.roomsAvailableNights} room nights{t.averageRate !== null ? `, average ${money(t.averageRate)}` : ""}</p>
            </div>
          </section>

          <div className="mt-6 overflow-x-auto print:overflow-visible">
            <table className="w-full min-w-[44rem] text-left text-sm print:min-w-0">
              <caption className="sr-only">Daily figures from {formatDate(range.from)} to {formatDate(range.to)}</caption>
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">Date</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Sold</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Occupancy</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Room revenue</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Extras</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Received</th>
                  <th scope="col" className="py-2 text-right font-medium">Refunded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {rows.map((r) => {
                  const occ = dayOccupancy(r);
                  return (
                    <tr key={r.day}>
                      <th scope="row" className="py-2 pr-4 font-normal">{formatDate(r.day)}</th>
                      <td className="py-2 pr-4 text-right">{r.rooms_sold} of {r.rooms_available}</td>
                      <td className="py-2 pr-4 text-right">{occ === null ? "None" : `${occ}%`}</td>
                      <td className="py-2 pr-4 text-right">{money(r.room_revenue_minor)}</td>
                      <td className="py-2 pr-4 text-right">{money(r.extras_minor)}</td>
                      <td className="py-2 pr-4 text-right">{money(r.cash_in_minor)}</td>
                      <td className="py-2 text-right">{money(r.refunds_paid_minor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {mayExport === true && <p className="mt-4 print:hidden"><a href={csvHref} className="text-sm font-medium text-primary-strong focus-visible:outline-2 focus-visible:outline-primary">Download as CSV</a></p>}
        </>
      )}
    </main>
  );
}
