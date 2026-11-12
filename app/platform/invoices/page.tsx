import Link from "next/link";
import { EmptyState, ErrorBanner, headRow, linkClass, PageIntro, PageTitle, thRowHead } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { daysLate, overdueInvoices, readOpenInvoices, totalsByCurrency } from "@/lib/platform/invoices";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Every unpaid invoice the platform has raised, across all hotels, oldest due date first. Read only: to record a payment or void an
 * invoice, open the hotel (admin). Nothing is sent to the hotel from here; contact them with the invoice number.
 */
export default async function PlatformInvoices() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_open_invoices");
  const list = readOpenInvoices(data);
  const today = new Date().toISOString().slice(0, 10);
  const late = overdueInvoices(list, today);

  return (
    <main className="max-w-5xl">
      <PageTitle>Unpaid invoices</PageTitle>
      <PageIntro>
        Invoices raised and not yet paid, across all hotels, oldest due date first. To record a payment or void one, open the hotel. Nothing
        is sent to the hotel from here.
      </PageIntro>
      {error && <ErrorBanner className="my-5">The list could not be loaded. Reload the page.</ErrorBanner>}
      {!error && list.length > 0 && (
        <p className="mt-4 text-sm">
          Owed:{" "}
          <span className="font-medium">
            {totalsByCurrency(list)
              .map(([c, m]) => formatMoney(m, c))
              .join(", ")}
          </span>
          {late.length > 0 && (
            <>
              {" "}
              &middot; <span className="font-medium text-critical">{late.length} overdue</span> (
              {totalsByCurrency(late)
                .map(([c, m]) => formatMoney(m, c))
                .join(", ")}
              )
            </>
          )}
        </p>
      )}
      {list.length === 0 ? (
        <EmptyState className="mt-6">{error ? "Nothing could be confirmed." : "No unpaid invoices."}</EmptyState>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={headRow}>
                <th scope="col" className={thRowHead}>
                  Hotel
                </th>
                <th scope="col" className={thRowHead}>
                  Invoice
                </th>
                <th scope="col" className={thRowHead}>
                  Period
                </th>
                <th scope="col" className={thRowHead}>
                  Amount
                </th>
                <th scope="col" className={thRowHead}>
                  Due
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => {
                const days = daysLate(i.due_date, today);
                return (
                  <tr key={i.id} className="border-b border-line align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/platform/${i.tenant_id}`} className={linkClass}>
                        {i.tenant_name}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">
                      {i.number}
                      {i.note && <span className="block text-xs text-muted">{i.note}</span>}
                    </td>
                    <td className="py-2 pr-3 text-muted">
                      {i.period_start} to {i.period_end}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{formatMoney(i.amount_minor, i.currency)}</td>
                    <td className={days > 0 ? "py-2 pr-3 font-medium text-critical" : "py-2 pr-3 text-muted"}>
                      {i.due_date ? (days > 0 ? `${i.due_date} (${days} day${days === 1 ? "" : "s"} late)` : i.due_date) : "No due date"}
                    </td>
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
