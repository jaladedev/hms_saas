import Link from "next/link";
import { PrintButton } from "@/components/staff/print-button";
import { PrintHeader } from "@/components/staff/print-header";
import { inputClass, buttonPrimary, linkClass, EmptyState, PageIntro, StatTile, tdNum, thNum, headRow, totalRow, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { adrMinor, formatBp, isQuietDay, occupancyBp, revparMinor, type OccupancyReport } from "@/lib/staff/occupancy";
import { MAX_RANGE_DAYS, parseRange, presets } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function OccupancyPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name");
  const all = (props ?? []) as { id: string; name: string; timezone: string }[];
  const allowed = (await Promise.all(all.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "report.view" });
    return data === true ? p : null;
  }))).filter((p): p is (typeof all)[number] => p !== null);

  if (allowed.length === 0) {
    return (
      <main className="max-w-2xl">
        <PageTitle>Occupancy</PageTitle>
        <EmptyState className="mt-4">You do not have permission to see reports.</EmptyState>
      </main>
    );
  }

  const chosen = pickProperty(allowed, typeof search.property === "string" ? search.property : undefined, await rememberedProperty())!;
  const today = todayIn(chosen.timezone, new Date());
  const range = parseRange(search.from, search.to, today);
  const { data, error } = await supabase.rpc("occupancy_report", { p_property_id: chosen.id, p_from: range.from, p_to: range.to });
  const report = error ? null : (data as OccupancyReport);
  const { data: mayExport } = await supabase.rpc("has_permission", { p_property: chosen.id, p_permission: "report.export" });
  const money = (n: number | null) => (n === null ? "–" : formatMoney(n, report?.currency ?? "NGN"));
  const qs = (from: string, to: string) => `?${new URLSearchParams({ property: chosen.id, from, to })}`;

  return (
    <main>
      <p className="text-sm print:hidden">
        <Link href="/app/reports" className={linkClass}>Money and revenue report</Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/app/reports/channels${qs(range.from, range.to)}`} className={linkClass}>Channels and guests</Link>
      </p>
      <PageTitle className="mt-2">Occupancy</PageTitle>
      <PrintHeader hotel={chosen.name} from={range.from} to={range.to} />
      <PageIntro>
        How many rooms were sold each night, what they earned, and what was coming and going. Days are the hotel&rsquo;s own days, and future days show what is booked so far.
      </PageIntro>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 print:hidden">
        {allowed.length > 1 && (
          <div>
            <label htmlFor="property" className="block text-sm">Property</label>
            <select id="property" name="property" defaultValue={chosen.id} className={inputClass}>
              {allowed.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="from" className="block text-sm">From</label>
          <input id="from" name="from" type="date" required defaultValue={range.from} className={inputClass} />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">To</label>
          <input id="to" name="to" type="date" required defaultValue={range.to} className={inputClass} />
        </div>
        <button type="submit" className={buttonPrimary}>Show</button>
        <PrintButton />
      </form>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm print:hidden">
        {presets(today).map((p) => (
          <Link key={p.label} href={qs(p.from, p.to)} className={linkClass}>{p.label}</Link>
        ))}
      </p>
      {mayExport === true && report && (
        <p className="mt-3 text-sm print:hidden">
          <a href={`/app/reports/occupancy/csv?${new URLSearchParams({ property: chosen.id, from: range.from, to: range.to })}`} className={linkClass}>Download as CSV</a>
        </p>
      )}
      {range.trimmed && <p role="status" className="mt-3 text-sm text-pending">That range is longer than {MAX_RANGE_DAYS} days, so the most recent {MAX_RANGE_DAYS} days are shown.</p>}

      {!report ? (
        <p role="alert" className="mt-6 rounded border border-critical/40 bg-white p-3 text-critical">The report could not be loaded. Try again, or choose a shorter range.</p>
      ) : (
        <>
          <section aria-label="Totals" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Occupancy" value={formatBp(occupancyBp(report.totals))} note={`${report.totals.rooms_sold} of ${report.totals.rooms_available} room nights`} />
            <StatTile label="ADR" value={money(adrMinor(report.totals))} note="room revenue per sold night, before tax" />
            <StatTile label="RevPAR" value={money(revparMinor(report.totals))} note="room revenue per available night, before tax" />
            <StatTile label="Room revenue" value={money(report.totals.room_revenue_minor)} note={`${report.totals.arrivals} arrivals, ${report.totals.departures} departures`} />
          </section>

          <div className="mt-6 overflow-x-auto print:overflow-visible">
            <table className="w-full min-w-[48rem] text-sm print:min-w-0 print:text-xs">
              <caption className="sr-only">Occupancy from {report.from} to {report.to}</caption>
              <thead>
                <tr className={headRow}>
                  <th scope="col" className="py-2 pr-3 font-normal">Day</th>
                  <th scope="col" className={thNum}>In service</th>
                  <th scope="col" className={thNum}>Blocked</th>
                  <th scope="col" className={thNum}>Sold</th>
                  <th scope="col" className={thNum}>Occupancy</th>
                  <th scope="col" className={thNum}>Room revenue</th>
                  <th scope="col" className={thNum}>ADR</th>
                  <th scope="col" className={thNum}>RevPAR</th>
                  <th scope="col" className={thNum}>Arrivals</th>
                  <th scope="col" className={thNum}>Departures</th>
                  <th scope="col" className={thNum}>No-shows</th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((d) => (
                  <tr key={d.date} className={`border-b border-line tabular-nums ${isQuietDay(d) ? "text-muted" : ""}`}>
                    <th scope="row" className="whitespace-nowrap py-2 pr-3 text-left font-normal">{formatDate(d.date)}</th>
                    <td className={tdNum}>{d.rooms_total}</td>
                    <td className={tdNum}>{d.rooms_blocked || "–"}</td>
                    <td className={tdNum}>{d.rooms_sold || "–"}</td>
                    <td className="px-2 py-2 text-right font-medium">{formatBp(occupancyBp(d))}</td>
                    <td className={tdNum}>{d.room_revenue_minor ? money(d.room_revenue_minor) : "–"}</td>
                    <td className={tdNum}>{money(adrMinor(d))}</td>
                    <td className={tdNum}>{d.room_revenue_minor ? money(revparMinor(d)) : "–"}</td>
                    <td className={tdNum}>{d.arrivals || "–"}</td>
                    <td className={tdNum}>{d.departures || "–"}</td>
                    <td className={tdNum}>{d.no_shows || "–"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={totalRow}>
                  <th scope="row" className="py-2 pr-3 text-left">Total</th>
                  <td className={tdNum} title="Room nights in service">{report.totals.rooms_total}</td>
                  <td className={tdNum}>{report.totals.rooms_blocked}</td>
                  <td className={tdNum}>{report.totals.rooms_sold}</td>
                  <td className={tdNum}>{formatBp(occupancyBp(report.totals))}</td>
                  <td className={tdNum}>{money(report.totals.room_revenue_minor)}</td>
                  <td className={tdNum}>{money(adrMinor(report.totals))}</td>
                  <td className={tdNum}>{money(revparMinor(report.totals))}</td>
                  <td className={tdNum}>{report.totals.arrivals}</td>
                  <td className={tdNum}>{report.totals.departures}</td>
                  <td className={tdNum}>{report.totals.no_shows}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <ul className="mt-6 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Sold counts one room night for each night of a confirmed, checked-in or checked-out booking. Unpaid holds, cancelled and no-show bookings are not sold.</li>
            <li>Available is the rooms in service minus rooms blocked that night. Occupancy is sold divided by available; the total row divides the whole range, it does not average the days.</li>
            <li>ADR and RevPAR use room revenue before tax and leave out extras.</li>
            <li>The room list keeps no history, so a room taken out of service or retired later is not counted on earlier days. Occupancy never shows above 100%.</li>
          </ul>
        </>
      )}
    </main>
  );
}

