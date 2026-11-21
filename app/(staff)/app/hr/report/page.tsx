import Link from "next/link";
import { cardClass, EmptyState, ErrorBanner, inputClass, linkClass, PageIntro, PageTitle } from "@/components/staff/ui";
import { buttonPrimary } from "@/components/staff/ui";
import { decimalHours, parseHoursReport } from "@/lib/staff/hr";
import { loadHrContext } from "@/lib/staff/hr-access";
import { todayIn } from "@/lib/staff/reservations";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Hours worked, hours scheduled and leave days per person over a date range, with a CSV for whoever does the payroll. Managers only. */
export default async function HrReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadHrContext(first(search.property));
  const heading = <PageTitle>Hours report</PageTitle>;
  if (loadFailed || !property || !can.manage)
    return (
      <main className="max-w-4xl">
        {heading}
        <p className="mt-4 max-w-prose text-muted">The hours report is for the owner and general manager.</p>
      </main>
    );
  const today = todayIn(property.timezone, new Date());
  const f = first(search.from);
  const t = first(search.to);
  const to = t && DATE.test(t) ? t : today;
  const from = f && DATE.test(f) ? f : addDays(to, -13);
  const { data, error } = await supabase.rpc("hr_hours_report", { p_property: property.id, p_from: from, p_to: to });
  const report = parseHoursReport(data);
  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Worked hours are counted by the day of clock-in, scheduled hours by the day a shift starts, and leave days are approved leave inside
        the dates. No pay is calculated.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href={`/app/hr?property=${property.id}`} className={linkClass}>
          Back to shifts and leave
        </Link>
      </p>
      <form className={`${cardClass} mt-4 flex flex-wrap items-end gap-3`}>
        <input type="hidden" name="property" value={property.id} />
        <label className="block text-xs" htmlFor="from">
          From
          <input id="from" name="from" type="date" defaultValue={from} className={`${inputClass} mt-1`} />
        </label>
        <label className="block text-xs" htmlFor="to">
          To
          <input id="to" name="to" type="date" defaultValue={to} className={`${inputClass} mt-1`} />
        </label>
        <button className={buttonPrimary}>Show</button>
        <a href={`/app/hr/report/csv?property=${property.id}&from=${from}&to=${to}`} className={linkClass}>
          Download CSV
        </a>
      </form>
      {error || !report ? (
        <ErrorBanner className="mt-4">The report could not be made. Check the dates (at most a year) and try again.</ErrorBanner>
      ) : report.people.length === 0 ? (
        <EmptyState className="mt-4">No staff.</EmptyState>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="pr-3">Worked h</th>
                <th className="pr-3">Scheduled h</th>
                <th className="pr-3">Annual</th>
                <th className="pr-3">Sick</th>
                <th className="pr-3">Unpaid</th>
                <th className="pr-3">Other</th>
                <th className="pr-3">Open</th>
                <th>Corrected</th>
              </tr>
            </thead>
            <tbody>
              {report.people.map((p) => (
                <tr key={p.userId} className="border-t border-line">
                  <td className="py-2 pr-3 font-medium">{p.name}</td>
                  <td className="pr-3">{decimalHours(p.workedMinutes)}</td>
                  <td className="pr-3">{decimalHours(p.scheduledMinutes)}</td>
                  <td className="pr-3">{p.leaveDays.annual}</td>
                  <td className="pr-3">{p.leaveDays.sick}</td>
                  <td className="pr-3">{p.leaveDays.unpaid}</td>
                  <td className="pr-3">{p.leaveDays.other}</td>
                  <td className="pr-3">{p.openRows}</td>
                  <td>{p.correctedRows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
