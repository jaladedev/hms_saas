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
  tdNum,
  thNum,
  thRowHead,
} from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { formatQty, parseStockReport } from "@/lib/staff/inventory";
import { loadInventoryContext } from "@/lib/staff/inventory-access";
import { parseDay } from "@/lib/staff/pos";
import { todayIn } from "@/lib/staff/reservations";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Stock movement by item for a window of hotel days (migration 150). Costs show only to people who may see money. */
export default async function StockReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadInventoryContext(first(search.property));
  const heading = <PageTitle>Stock report</PageTitle>;
  if (loadFailed || !property || !can.report)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">The stock report is for people who may view reports.</p>
        )}
      </main>
    );
  const today = todayIn(property.timezone, new Date());
  const to = parseDay(first(search.to), today);
  const fromRaw = parseDay(first(search.from), `${to.slice(0, 8)}01`);
  const from = fromRaw > to ? to : fromRaw;
  const q = await supabase.rpc("stock_report", { p_property: property.id, p_from: from, p_to: to });
  const report = q.error ? null : parseStockReport(q.data);
  const tooLong = Boolean(q.error && /dates/.test(q.error.message));
  const money = (m: number | null) => (m === null ? "—" : formatMoney(m, property.currency));

  return (
    <main className="max-w-5xl">
      {heading}
      <PageIntro>
        Bought, sold through the restaurant, used, wasted and count differences for each item over the days you choose. Waste is valued at
        the latest price paid. Costs are hidden from people who may not see money.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/inventory" className={linkClass}>
          ← Stock
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
      {q.error && !tooLong && <ErrorBanner className="mt-4">The report could not be loaded. Reload the page.</ErrorBanner>}
      {report &&
        (report.items.length === 0 ? (
          <EmptyState className="mt-8">There are no items yet.</EmptyState>
        ) : (
          <div className="mt-8 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th scope="col" className={thRowHead}>
                    Item
                  </th>
                  <th scope="col" className={thNum}>
                    Bought
                  </th>
                  <th scope="col" className={thNum}>
                    Sold
                  </th>
                  <th scope="col" className={thNum}>
                    Used
                  </th>
                  <th scope="col" className={thNum}>
                    Wasted
                  </th>
                  <th scope="col" className={thNum}>
                    Count diff.
                  </th>
                  <th scope="col" className={thNum}>
                    On hand
                  </th>
                  {report.spentMinor !== null && (
                    <>
                      <th scope="col" className={thNum}>
                        Spent
                      </th>
                      <th scope="col" className={thNum}>
                        Waste value
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {report.items.map((r) => (
                  <tr key={r.itemId} className="border-b border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {r.name} <span className="text-xs text-muted">{r.unit}</span>
                    </th>
                    <td className={tdNum}>{formatQty(r.bought)}</td>
                    <td className={tdNum}>{formatQty(r.sold)}</td>
                    <td className={tdNum}>{formatQty(r.used)}</td>
                    <td className={tdNum}>{formatQty(r.wasted)}</td>
                    <td className={tdNum}>{formatQty(r.countDifference)}</td>
                    <td className={`${tdNum} ${r.onHand < 0 ? "text-red-700" : ""}`}>
                      {formatQty(r.onHand)}
                      {r.low ? " (low)" : ""}
                    </td>
                    {report.spentMinor !== null && (
                      <>
                        <td className={tdNum}>{money(r.spentMinor)}</td>
                        <td className={tdNum}>{money(r.wasteValueMinor)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {report.spentMinor !== null && (
                <tfoot>
                  <tr>
                    <th scope="row" className="py-2 pr-3 text-left">
                      Total spent
                    </th>
                    <td colSpan={7} className={tdNum}>
                      {money(report.spentMinor)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ))}
    </main>
  );
}
