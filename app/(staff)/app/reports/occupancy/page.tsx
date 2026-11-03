import Link from "next/link";
import { inputClass, buttonPrimary } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { adrMinor, formatBp, isQuietDay, occupancyBp, revparMinor, type OccupancyReport } from "@/lib/staff/occupancy";
import { ERROR_TEXT, parseRange, presets } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

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
        <h1 className="font-display text-3xl">Occupancy</h1>
        <p className="mt-4 rounded border border-line bg-white px-4 py-6 text-muted">You do not have permission to see reports.</p>
      </main>
    );
  }

  const chosen = allowed.find((p) => p.id === search.property) ?? allowed[0]!;
  const today = todayIn(chosen.timezone, new Date());
  const range = parseRange({ from: search.from, to: search.to }, today);
  const { data, error } = await supabase.rpc("occupancy_report", { p_property_id: chosen.id, p_from: range.from, p_to: range.to });
  const report = error ? null : (data as OccupancyReport);
  const { data: mayExport } = await supabase.rpc("has_permission", { p_property: chosen.id, p_permission: "report.export" });
  const money = (n: number | null) => (n === null ? "–" : formatMoney(n, report?.currency ?? "NGN"));
  const qs = (from: string, to: string) => `?${new URLSearchParams({ property: chosen.id, from, to })}`;

  return (
    <main>
      <p className="text-sm"><Link href="/app/reports" className="text-primary-strong underline underline-offset-2">Money and revenue report</Link></p>
      <h1 className="mt-2 font-display text-3xl">Occupancy</h1>
      <p className="mt-2 max-w-prose text-muted">
        How many rooms were sold each night, what they earned, and what was coming and going. Days are the hotel&rsquo;s own days, and future days show what is booked so far.
      </p>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
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
      </form>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {presets(today).map((p) => (
          <Link key={p.label} href={qs(p.from, p.to)} className="text-primary-strong underline underline-offset-2">{p.label}</Link>
        ))}
      </p>
      {mayExport === true && report && (
        <p className="mt-3 text-sm">
          <a href={`/app/reports/occupancy/csv?${new URLSearchParams({ property: chosen.id, from: range.from, to: range.to })}`} className="text-primary-strong underline underline-offset-2">Download as CSV</a>
        </p>
      )}
      {range.fixed && <p role="status" className="mt-3 text-sm text-pending">{ERROR_TEXT.fixed}</p>}

      {!report ? (
        <p role="alert" className="mt-6 rounded border border-critical/40 bg-white p-3 text-critical">The report could not be loaded. Try again, or choose a shorter range.</p>
      ) : (
        <>
          <section aria-label="Totals" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Occupancy" value={formatBp(occupancyBp(report.totals))} note={`${report.totals.rooms_sold} of ${report.totals.rooms_available} room nights`} />
            <Tile label="ADR" value={money(adrMinor(report.totals))} note="room revenue per sold night, before tax" />
            <Tile label="RevPAR" value={money(revparMinor(report.totals))} note="room revenue per available night, before tax" />
            <Tile label="Room revenue" value={money(report.totals.room_revenue_minor)} note={`${report.totals.arrivals} arrivals, ${report.totals.departures} departures`} />
          </section>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <caption className="sr-only">Occupancy from {report.from} to {report.to}</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-normal">Day</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">In service</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Blocked</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Sold</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Occupancy</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Room revenue</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">ADR</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">RevPAR</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Arrivals</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Departures</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">No-shows</th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((d) => (
                  <tr key={d.date} className={`border-b border-line tabular-nums ${isQuietDay(d) ? "text-muted" : ""}`}>
                    <th scope="row" className="whitespace-nowrap py-2 pr-3 text-left font-normal">{formatDate(d.date)}</th>
                    <td className="px-2 py-2 text-right">{d.rooms_total}</td>
                    <td className="px-2 py-2 text-right">{d.rooms_blocked || "–"}</td>
                    <td className="px-2 py-2 text-right">{d.rooms_sold || "–"}</td>
                    <td className="px-2 py-2 text-right font-medium">{formatBp(occupancyBp(d))}</td>
                    <td className="px-2 py-2 text-right">{d.room_revenue_minor ? money(d.room_revenue_minor) : "–"}</td>
                    <td className="px-2 py-2 text-right">{money(adrMinor(d))}</td>
                    <td className="px-2 py-2 text-right">{d.room_revenue_minor ? money(revparMinor(d)) : "–"}</td>
                    <td className="px-2 py-2 text-right">{d.arrivals || "–"}</td>
                    <td className="px-2 py-2 text-right">{d.departures || "–"}</td>
                    <td className="px-2 py-2 text-right">{d.no_shows || "–"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold tabular-nums">
                  <th scope="row" className="py-2 pr-3 text-left">Total</th>
                  <td className="px-2 py-2 text-right" title="Room nights in service">{report.totals.rooms_total}</td>
                  <td className="px-2 py-2 text-right">{report.totals.rooms_blocked}</td>
                  <td className="px-2 py-2 text-right">{report.totals.rooms_sold}</td>
                  <td className="px-2 py-2 text-right">{formatBp(occupancyBp(report.totals))}</td>
                  <td className="px-2 py-2 text-right">{money(report.totals.room_revenue_minor)}</td>
                  <td className="px-2 py-2 text-right">{money(adrMinor(report.totals))}</td>
                  <td className="px-2 py-2 text-right">{money(revparMinor(report.totals))}</td>
                  <td className="px-2 py-2 text-right">{report.totals.arrivals}</td>
                  <td className="px-2 py-2 text-right">{report.totals.departures}</td>
                  <td className="px-2 py-2 text-right">{report.totals.no_shows}</td>
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

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded border border-line bg-white p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </div>
  );
}
