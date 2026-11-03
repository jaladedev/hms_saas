import Link from "next/link";
import { inputClass, buttonPrimary } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { CHANNELS, earnedMinor, ERROR_TEXT, isQuiet, parseRange, presets, taxMinor, type Report } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name");
  const all = (props ?? []) as { id: string; name: string; timezone: string }[];
  // Only properties where the viewer may read reports (the database checks again on every call).
  const allowed = (await Promise.all(all.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "report.view" });
    return data === true ? p : null;
  }))).filter((p): p is (typeof all)[number] => p !== null);

  if (allowed.length === 0) {
    return (
      <main className="max-w-2xl">
        <h1 className="font-display text-3xl">Reports</h1>
        <p className="mt-4 rounded border border-line bg-white px-4 py-6 text-muted">You do not have permission to see reports.</p>
      </main>
    );
  }

  const chosen = allowed.find((p) => p.id === search.property) ?? allowed[0]!;
  const today = todayIn(chosen.timezone, new Date());
  const range = parseRange({ from: search.from, to: search.to }, today);
  const { data, error } = await supabase.rpc("daily_report", { p_property_id: chosen.id, p_from: range.from, p_to: range.to });
  const report = error ? null : (data as Report);
  const { data: mayExport } = await supabase.rpc("has_permission", { p_property: chosen.id, p_permission: "report.export" });
  const money = (n: number) => formatMoney(n, report?.currency ?? "NGN");
  const qs = (from: string, to: string) => `?${new URLSearchParams({ property: chosen.id, from, to })}`;

  return (
    <main>
      <h1 className="font-display text-3xl">Reports</h1>
      <p className="mt-2 max-w-prose text-muted">
        Money in and out by the day it happened, and what was earned by the night or day it belongs to. Days are the hotel&rsquo;s own days.
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
          <a href={`/app/reports/csv?${new URLSearchParams({ property: chosen.id, from: range.from, to: range.to })}`} className="text-primary-strong underline underline-offset-2">Download as CSV</a>
        </p>
      )}
      {range.fixed && <p role="status" className="mt-3 text-sm text-pending">{ERROR_TEXT.fixed}</p>}

      {!report ? (
        <p role="alert" className="mt-6 rounded border border-critical/40 bg-white p-3 text-critical">The report could not be loaded. Try again, or choose a shorter range.</p>
      ) : (
        <>
          <section aria-label="Totals" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Received" value={money(report.totals.received_minor)} note="payments and folio payments" />
            <Tile label="Refunded" value={money(report.totals.refunded_minor)} note="paid out to guests" />
            <Tile label="Net cash in" value={money(report.totals.net_minor)} note="received minus refunded" />
            <Tile label="Earned" value={money(earnedMinor(report.totals))} note={`before ${money(taxMinor(report.totals))} tax`} />
          </section>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <caption className="sr-only">Daily report from {report.from} to {report.to}</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-normal">Day</th>
                  {CHANNELS.map((c) => <th key={c.key} scope="col" className="px-2 py-2 text-right font-normal">{c.label}</th>)}
                  <th scope="col" className="px-2 py-2 text-right font-normal">Received</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Refunded</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Rooms</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Extras</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Cancel. charges</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">Tax</th>
                </tr>
              </thead>
              <tbody>
                {report.days.map((d) => (
                  <tr key={d.date} className={`border-b border-line tabular-nums ${isQuiet(d) ? "text-muted" : ""}`}>
                    <th scope="row" className="whitespace-nowrap py-2 pr-3 text-left font-normal">{formatDate(d.date)}</th>
                    {CHANNELS.map((c) => <td key={c.key} className="px-2 py-2 text-right">{d[c.key] ? money(d[c.key]) : "–"}</td>)}
                    <td className="px-2 py-2 text-right font-medium">{d.received_minor ? money(d.received_minor) : "–"}</td>
                    <td className="px-2 py-2 text-right">{d.refunded_minor ? money(d.refunded_minor) : "–"}</td>
                    <td className="px-2 py-2 text-right">{d.room_revenue_minor ? money(d.room_revenue_minor) : "–"}</td>
                    <td className="px-2 py-2 text-right">{d.extras_minor ? money(d.extras_minor) : "–"}</td>
                    <td className="px-2 py-2 text-right">{d.cancellation_charges_minor ? money(d.cancellation_charges_minor) : "–"}</td>
                    <td className="px-2 py-2 text-right">{taxMinor(d) ? money(taxMinor(d)) : "–"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold tabular-nums">
                  <th scope="row" className="py-2 pr-3 text-left">Total</th>
                  {CHANNELS.map((c) => <td key={c.key} className="px-2 py-2 text-right">{money(report.totals[c.key])}</td>)}
                  <td className="px-2 py-2 text-right">{money(report.totals.received_minor)}</td>
                  <td className="px-2 py-2 text-right">{money(report.totals.refunded_minor)}</td>
                  <td className="px-2 py-2 text-right">{money(report.totals.room_revenue_minor)}</td>
                  <td className="px-2 py-2 text-right">{money(report.totals.extras_minor)}</td>
                  <td className="px-2 py-2 text-right">{money(report.totals.cancellation_charges_minor)}</td>
                  <td className="px-2 py-2 text-right">{money(taxMinor(report.totals))}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <ul className="mt-6 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Received counts payments that went through; a payment that was reversed is not counted. Refunds count on the day they were paid out.</li>
            <li>Rooms and Extras are before tax. Rooms counts the nights of confirmed, checked-in and checked-out bookings on the night itself, so future nights are booked, not yet earned. Unpaid holds, cancelled and no-show bookings add nothing.</li>
            <li>A cancellation charge counts on the day the booking was cancelled, with its tax inside it.</li>
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
