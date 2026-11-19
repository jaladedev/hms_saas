import Link from "next/link";
import {
  buttonQuiet,
  EmptyState,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
  tdNum,
  thNum,
  thRowHead,
} from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { methodLabel, parseDay, parseSales } from "@/lib/staff/pos";
import { loadPosContext } from "@/lib/staff/pos-access";
import { todayIn } from "@/lib/staff/reservations";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Restaurant sales for a window of hotel days (migration 148). Two sources, kept apart on purpose: bills paid at the table, and bills put on a
 * room bill. The room ones are already extras in the daily report; the table ones are only here.
 */
export default async function PosSalesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadPosContext(first(search.property));
  const heading = <PageTitle>Restaurant sales</PageTitle>;
  if (loadFailed || !property || !can.report)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">
            The sales report is for people who may view reports. Ask the owner or general manager.
          </p>
        )}
      </main>
    );

  const today = todayIn(property.timezone, new Date());
  const to = parseDay(first(search.to), today);
  const fromRaw = parseDay(first(search.from), to);
  const from = fromRaw > to ? to : fromRaw;
  const reportQ = await supabase.rpc("pos_sales_report", { p_property: property.id, p_from: from, p_to: to });
  const report = reportQ.error ? null : parseSales(reportQ.data);
  const money = (m: number) => formatMoney(m, property.currency);
  const tooLong = Boolean(reportQ.error && /dates/.test(reportQ.error.message));

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Bills that were settled in the days you choose, by the hotel&rsquo;s own day. Voided orders are not sales. Bills put on a room are
        already counted as extras in the daily report; bills paid at the table are counted only here.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/pos" className={linkClass}>
          ← Restaurant &amp; bar
        </Link>
      </p>
      <form method="get" className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block text-sm" htmlFor="from">
          From
          <input id="from" name="from" type="date" defaultValue={from} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-sm" htmlFor="to">
          To
          <input id="to" name="to" type="date" defaultValue={to} className={`${inputClass} mt-1`} />
        </label>
        <button type="submit" className={buttonQuiet}>
          Show
        </button>
      </form>
      {tooLong && <ErrorBanner className="mt-4">Choose at most 366 days.</ErrorBanner>}
      {reportQ.error && !tooLong && <ErrorBanner className="mt-4">The report could not be loaded. Reload the page.</ErrorBanner>}

      {report && (
        <>
          <section className="mt-8" aria-label="Totals">
            <SectionTitle>Totals</SectionTitle>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={headRow}>
                    <th scope="col" className={thRowHead}>
                      Settled
                    </th>
                    <th scope="col" className={thNum}>
                      Orders
                    </th>
                    <th scope="col" className={thNum}>
                      Before tax
                    </th>
                    <th scope="col" className={thNum}>
                      Tax
                    </th>
                    <th scope="col" className={thNum}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      Paid at the table
                    </th>
                    <td className={tdNum}>{report.tableOrders}</td>
                    <td className={tdNum}>{money(report.tableSubtotalMinor)}</td>
                    <td className={tdNum}>{money(report.tableTaxMinor)}</td>
                    <td className={tdNum}>{money(report.tableTotalMinor)}</td>
                  </tr>
                  <tr className="border-b border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      Put on a room bill
                    </th>
                    <td className={tdNum}>{report.roomOrders}</td>
                    <td className={tdNum}>{money(report.roomSubtotalMinor)}</td>
                    <td className={tdNum}>{money(report.roomTaxMinor)}</td>
                    <td className={tdNum}>{money(report.roomTotalMinor)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-muted">Voided orders in these days: {report.voidedOrders}.</p>
          </section>

          {report.byDay.length === 0 ? (
            <EmptyState className="mt-8">No bills were settled in these days.</EmptyState>
          ) : (
            <>
              <section className="mt-8" aria-label="By day">
                <SectionTitle>By day</SectionTitle>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={headRow}>
                        <th scope="col" className={thRowHead}>
                          Day
                        </th>
                        <th scope="col" className={thNum}>
                          Orders
                        </th>
                        <th scope="col" className={thNum}>
                          Table
                        </th>
                        <th scope="col" className={thNum}>
                          Room
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byDay.map((d) => (
                        <tr key={d.day} className="border-b border-line">
                          <th scope="row" className="py-2 pr-3 text-left font-normal">
                            {formatDate(d.day)}
                          </th>
                          <td className={tdNum}>{d.orders}</td>
                          <td className={tdNum}>{money(d.tableTotalMinor)}</td>
                          <td className={tdNum}>{money(d.roomTotalMinor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="mt-8 grid gap-8 md:grid-cols-2">
                <div>
                  <SectionTitle>Table payments by method</SectionTitle>
                  {report.byMethod.length === 0 ? (
                    <p className="mt-3 text-sm text-muted">None.</p>
                  ) : (
                    <ul className="mt-3 grid gap-1 text-sm">
                      {report.byMethod.map((m) => (
                        <li key={m.method} className="flex justify-between border-b border-line py-1">
                          <span>
                            {methodLabel(m.method)} ({m.orders})
                          </span>
                          <span className="tabular-nums">{money(m.totalMinor)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <SectionTitle>Best sellers (before tax)</SectionTitle>
                  <ul className="mt-3 grid gap-1 text-sm">
                    {report.topItems.map((i) => (
                      <li key={i.name} className="flex justify-between gap-3 border-b border-line py-1">
                        <span>
                          {i.name} × {i.quantity}
                        </span>
                        <span className="tabular-nums">{money(i.salesMinor)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
