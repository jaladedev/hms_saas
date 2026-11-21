import Link from "next/link";
import { EmptyState, ErrorBanner, headRow, linkClass, PageIntro, PageTitle, thRowHead } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { parseOverdue, reminderSummary } from "@/lib/staff/groups";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Group invoices (migration 154) that are issued and past their due date, oldest first. Needs group.manage and the right to see money. */
export default async function OverduePage() {
  const supabase = await createClient();
  const { data: props, error } = await supabase.from("properties").select("id, name").order("name");
  const properties = (props ?? []) as { id: string; name: string }[];
  const lists = await Promise.all(properties.map((p) => supabase.rpc("group_invoice_overdue", { p_property: p.id })));
  const many = properties.length > 1;
  const visible = lists.filter((l) => !l.error);

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/app/groups" className={linkClass}>
          All groups
        </Link>
      </p>
      <PageTitle>Overdue group invoices</PageTitle>
      <PageIntro>
        Company invoices that are issued, not paid and not void, with a due date before today. The last column shows the automatic email
        reminders (switched on per company). Open the group to chase the company or to mark the invoice paid.
      </PageIntro>
      {error && <ErrorBanner className="mt-4">Invoices could not be loaded. Reload the page.</ErrorBanner>}
      {visible.length === 0 && !error && <EmptyState className="mt-6">You do not have access to group invoices.</EmptyState>}
      {properties.map((p, i) => {
        const l = lists[i];
        if (!l || l.error) return null;
        const rows = parseOverdue(l.data);
        return (
          <section key={p.id} className="mt-8" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {rows.length === 0 ? (
              <EmptyState className="mt-4">Nothing is overdue.</EmptyState>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={headRow}>
                      <th className={thRowHead}>Invoice</th>
                      <th className={thRowHead}>Bill to</th>
                      <th className={thRowHead}>Group</th>
                      <th className={thRowHead}>Due</th>
                      <th className={thRowHead}>Days late</th>
                      <th className={thRowHead}>Amount</th>
                      <th className={thRowHead}>Reminders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.invoiceId} className="border-b border-line tabular-nums">
                        <td className="py-2 pr-3">
                          <Link href={`/app/groups/${r.groupId}/invoice/${r.invoiceId}`} className={linkClass}>
                            {r.number}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{r.billTo}</td>
                        <td className="py-2 pr-3">
                          <Link href={`/app/groups/${r.groupId}`} className={linkClass}>
                            {r.groupName}
                          </Link>
                        </td>
                        <td className="py-2 pr-3">{formatDate(r.dueDate)}</td>
                        <td className="py-2 pr-3">{r.daysOverdue}</td>
                        <td className="py-2 pr-3">{formatMoney(r.totalMinor, r.currency)}</td>
                        <td className="py-2 pr-3 tabular-nums">{reminderSummary(r.reminder, formatDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
