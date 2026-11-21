import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { PrintButton } from "@/components/staff/print-button";
import { linkClass, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import {
  PAY_METHOD_LABEL,
  parseCompanies,
  parseGroupDetail,
  parseGroupInvoices,
  parseReminderInfo,
  REMINDER_OUTCOME_LABEL,
  reminderSummary,
} from "@/lib/staff/groups";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Prop = { name: string; address: string | null; city: string; state: string };

/**
 * One company invoice for a group (migration 154), laid out to print. It shows the frozen copy kept when the invoice was issued, so a later
 * change to a booking never alters it. Opening it needs group.manage and the right to see money: the database answers NOT_FOUND otherwise.
 * "Paid" here only records that the company paid this invoice; it is not a receipt for the bookings' own payments.
 */
export default async function GroupInvoicePage({ params }: { params: Promise<{ id: string; invoiceId: string }> }) {
  const { id, invoiceId } = await params;
  if (!z.guid().safeParse(id).success || !z.guid().safeParse(invoiceId).success) notFound();
  const supabase = await createClient();

  const listQ = await supabase.rpc("group_invoice_list", { p_group: id });
  if (listQ.error) notFound();
  const invoice = parseGroupInvoices(listQ.data).find((i) => i.id === invoiceId);
  if (!invoice) notFound();
  const group = parseGroupDetail((await supabase.rpc("group_detail", { p_group: id })).data);
  if (!group) notFound();

  const [propQ, coQ, reminderQ] = await Promise.all([
    supabase.from("properties").select("name, address, city, state").eq("id", group.propertyId).maybeSingle(),
    group.companyId ? supabase.rpc("company_list", { p_property: group.propertyId }) : Promise.resolve({ data: null }),
    supabase.rpc("group_invoice_reminders", { p_invoice: invoiceId }),
  ]);
  const reminder = reminderQ.error || !group.companyId ? null : parseReminderInfo(reminderQ.data);
  const prop = (propQ.data ?? { name: "", address: null, city: "", state: "" }) as Prop;
  const company = parseCompanies(coQ.data).find((c) => c.id === group.companyId) ?? null;
  const money = (m: number) => formatMoney(m, invoice.currency);
  const isVoid = invoice.status === "void";

  return (
    <main className="max-w-3xl">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm print:hidden">
        <Link href={`/app/groups/${id}`} className={linkClass}>
          Back to the group
        </Link>
        <PrintButton />
      </p>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Invoice {invoice.number}</PageTitle>
          <p className="mt-1 text-sm text-muted">
            Group: {group.name}, {formatDate(group.arrival)} to {formatDate(group.departure)}
          </p>
        </div>
        <div className="text-sm sm:text-right">
          <p className="font-medium">{prop.name}</p>
          {prop.address && <p>{prop.address}</p>}
          <p>{[prop.city, prop.state].filter(Boolean).join(", ")}</p>
        </div>
      </div>

      {isVoid && (
        <p role="status" className="mt-4 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">
          <span className="font-semibold">Void.</span> This invoice was withdrawn{invoice.voidReason ? `: ${invoice.voidReason}` : "."} It
          is kept for the record and is not valid.
        </p>
      )}
      {invoice.status === "paid" && (
        <p role="status" className="mt-4 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
          <span className="font-semibold">Paid</span>
          {invoice.paidAt ? ` on ${formatDate(invoice.paidAt.slice(0, 10))}` : ""}
          {invoice.paidMethod ? ` by ${PAY_METHOD_LABEL[invoice.paidMethod] ?? invoice.paidMethod}` : ""}
          {invoice.paidReference ? `, reference ${invoice.paidReference}` : ""}.
        </p>
      )}

      <div className="mt-6 grid gap-6 text-sm sm:grid-cols-2">
        <div>
          <p className="text-muted">Bill to</p>
          <p className="font-medium">{invoice.billTo}</p>
          {company ? (
            <>
              <p>{company.contact}</p>
              {company.email && <p>{company.email}</p>}
              {company.phone && <p>{company.phone}</p>}
            </>
          ) : (
            <>
              <p>{group.contactName}</p>
              {group.contactEmail && <p>{group.contactEmail}</p>}
              {group.contactPhone && <p>{group.contactPhone}</p>}
            </>
          )}
        </div>
        <dl className="space-y-1">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Invoice date</dt>
            <dd>{formatDate(invoice.issuedAt.slice(0, 10))}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Due date</dt>
            <dd>{formatDate(invoice.dueDate)}</dd>
          </div>
          {company && company.creditDays > 0 && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Credit terms</dt>
              <dd>{company.creditDays} days</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="mt-8 overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[34rem] text-sm print:min-w-0">
          <caption className="sr-only">Bookings on invoice {invoice.number}</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="py-2 pr-3 font-normal">
                Guest
              </th>
              <th scope="col" className="px-2 py-2 font-normal">
                Booking
              </th>
              <th scope="col" className="px-2 py-2 font-normal">
                Stay
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Before tax
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Tax
              </th>
              <th scope="col" className="px-2 py-2 text-right font-normal">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.reference} className="border-b border-line tabular-nums">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {l.guest}
                </th>
                <td className="px-2 py-2">{l.reference}</td>
                <td className="px-2 py-2">
                  {formatDate(l.arrival)} to {formatDate(l.departure)}
                </td>
                <td className="px-2 py-2 text-right">{money(l.netMinor)}</td>
                <td className="px-2 py-2 text-right">{l.taxMinor > 0 ? money(l.taxMinor) : "–"}</td>
                <td className="px-2 py-2 text-right">{money(l.totalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ml-auto mt-4 max-w-xs text-sm tabular-nums">
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Before tax</dt>
          <dd>{money(invoice.subtotalMinor)}</dd>
        </div>
        <div className="flex justify-between gap-6 py-1.5">
          <dt className="text-muted">Tax</dt>
          <dd>{money(invoice.taxMinor)}</dd>
        </div>
        <div className="flex justify-between gap-6 border-t-2 border-ink py-2 text-base font-semibold">
          <dt>Total</dt>
          <dd>{money(invoice.totalMinor)}</dd>
        </div>
      </dl>

      {reminder && (invoice.status === "issued" || reminder.reminders.length > 0 || reminder.smsReminders.length > 0) && (
        <section className="mt-8 print:hidden" aria-label="Reminders">
          <h2 className="font-display text-lg">Overdue reminders</h2>
          <p className="mt-1 text-sm">{reminderSummary(reminder, formatDate)}.</p>
          {reminder.reminders.length > 0 && (
            <ul className="mt-2 grid gap-1 text-sm">
              {reminder.reminders.map((r) => (
                <li key={r.no}>
                  Reminder {r.no}: {REMINDER_OUTCOME_LABEL[r.outcome]}
                  {r.outcome === "sent" && r.sentAt ? ` on ${formatDate(r.sentAt.slice(0, 10))}` : ""}
                </li>
              ))}
            </ul>
          )}
          {(reminder.smsOn || reminder.smsReminders.length > 0) && (
            <>
              <p className="mt-3 text-sm">Texts to the billing phone: {reminder.smsOn ? "on" : "off"}.</p>
              {reminder.smsReminders.length > 0 && (
                <ul className="mt-2 grid gap-1 text-sm">
                  {reminder.smsReminders.map((r) => (
                    <li key={r.no}>
                      Text {r.no}: {REMINDER_OUTCOME_LABEL[r.outcome]}
                      {r.outcome === "sent" && r.sentAt ? ` on ${formatDate(r.sentAt.slice(0, 10))}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      <p className="mt-8 max-w-prose text-xs text-muted">
        This is a copy of the booking totals as they were when the invoice was issued. Extras charged during the stays are on each
        booking&rsquo;s own invoice and are not included here.
      </p>
    </main>
  );
}
