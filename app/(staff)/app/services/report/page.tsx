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
import { parseDay } from "@/lib/staff/pos";
import { todayIn } from "@/lib/staff/reservations";
import { parseServiceReport, SERVICE_KIND_LABEL } from "@/lib/staff/services";
import { loadServicesContext } from "@/lib/staff/services-access";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Bookings by status and what done and charged ones brought in, per service, over a window of hotel days (migration 151). */
export default async function ServicesReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadServicesContext(first(search.property));
  const heading = <PageTitle>Services report</PageTitle>;
  if (loadFailed || !property || !can.report)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">The services report is for people who may view reports.</p>
        )}
      </main>
    );
  const today = todayIn(property.timezone, new Date());
  const to = parseDay(first(search.to), today);
  const fromRaw = parseDay(first(search.from), `${to.slice(0, 8)}01`);
  const from = fromRaw > to ? to : fromRaw;
  const q = await supabase.rpc("service_report", { p_property: property.id, p_from: from, p_to: to });
  const report = q.error ? null : parseServiceReport(q.data);
  const tooLong = Boolean(q.error && /dates/.test(q.error.message));
  const money = (m: number | null) => (m === null ? "—" : formatMoney(m, property.currency));

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Bookings by status for each service in the days you choose (by the booking&rsquo;s time, or the day it was made for laundry).
        Revenue counts bookings that are done or on a room bill, and is hidden from people who may not see money.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/services" className={linkClass}>
          ← Spa, gym and laundry
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
        (report.services.length === 0 ? (
          <EmptyState className="mt-8">There are no services yet.</EmptyState>
        ) : (
          <div className="mt-8 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th scope="col" className={thRowHead}>
                    Service
                  </th>
                  <th scope="col" className={thNum}>
                    Booked
                  </th>
                  <th scope="col" className={thNum}>
                    Done
                  </th>
                  <th scope="col" className={thNum}>
                    On room bill
                  </th>
                  <th scope="col" className={thNum}>
                    Cancelled
                  </th>
                  <th scope="col" className={thNum}>
                    No-show
                  </th>
                  {report.revenueMinor !== null && (
                    <th scope="col" className={thNum}>
                      Revenue
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {report.services.map((r) => (
                  <tr key={r.serviceId} className="border-b border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {r.name} <span className="text-xs text-muted">{SERVICE_KIND_LABEL[r.kind]}</span>
                    </th>
                    <td className={tdNum}>{r.booked}</td>
                    <td className={tdNum}>{r.done}</td>
                    <td className={tdNum}>{r.charged}</td>
                    <td className={tdNum}>{r.cancelled}</td>
                    <td className={tdNum}>{r.noShow}</td>
                    {report.revenueMinor !== null && <td className={tdNum}>{money(r.revenueMinor)}</td>}
                  </tr>
                ))}
              </tbody>
              {report.revenueMinor !== null && (
                <tfoot>
                  <tr>
                    <th scope="row" className="py-2 pr-3 text-left">
                      Total revenue
                    </th>
                    <td colSpan={5} className={tdNum}>
                      {money(report.revenueMinor)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        ))}
    </main>
  );
}
