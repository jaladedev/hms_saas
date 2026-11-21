import Link from "next/link";
import { GroupNotice } from "@/components/staff/group-notice";
import {
  buttonPrimary,
  buttonQuiet,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { CREDIT_KIND_LABEL, parseCreditBalances, parseCreditLedger } from "@/lib/staff/company-credit";
import {
  createCompany,
  depositCompanyCredit,
  withdrawCompanyCredit,
  removeCompanyRate,
  setCompanyAutoRate,
  setCompanyReminders,
  setCompanyRate,
  updateCompany,
} from "@/lib/staff/group-actions";
import { formatMoney } from "@/lib/guest-site/format";
import { minorToInput } from "@/lib/staff/money-input";
import { parseCompanies } from "@/lib/staff/groups";
import { PAY_METHODS, PAY_METHOD_LABEL } from "@/lib/staff/groups";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Company accounts (migration 155): who to bill, credit days and an agreed discount. Owner and general manager change them. */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, currency").order("name");
  const properties = (props ?? []) as { id: string; name: string; currency: string }[];
  const lists = await Promise.all(properties.map((p) => supabase.rpc("company_list", { p_property: p.id })));
  // Credit balances need the right to see money; a person without it simply sees no balance.
  const balanceQs = await Promise.all(properties.map((p) => supabase.rpc("company_credit_balances", { p_property: p.id })));
  const creditLedgers = new Map<string, ReturnType<typeof parseCreditLedger>>();
  for (const [i, q] of balanceQs.entries()) {
    const l = lists[i];
    if (!l || l.error || q.error) continue;
    const bal = parseCreditBalances(q.data);
    for (const c of parseCompanies(l.data)) {
      if ((bal[c.id] ?? 0) !== 0) {
        const led = await supabase.rpc("company_credit_ledger_list", { p_company: c.id, p_limit: 10 });
        creditLedgers.set(c.id, led.error ? [] : parseCreditLedger(led.data));
      }
    }
  }
  const { data: types } = await supabase.from("room_types").select("id, name, property_id").eq("status", "active").order("name");
  const roomTypes = (types ?? []) as { id: string; name: string; property_id: string }[];
  const many = properties.length > 1;

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/app/groups" className={linkClass}>
          All groups
        </Link>
      </p>
      <PageTitle>Company accounts</PageTitle>
      <PageIntro>
        A company account holds who to bill, the days the company has to pay (credit days) and an agreed discount. Attach one to a group:
        the group invoice is made out to the company and suggests a due date from the credit days, and the agreed discount can be applied to
        the group&rsquo;s linked bookings. Credit days only suggest a due date. An optional credit limit stops a new group invoice that
        would take the company&rsquo;s unpaid invoices above it; nothing else is blocked when a company is late. Changing a discount later
        does not change bookings that already have it.
      </PageIntro>
      <div className="mt-6">
        <GroupNotice search={search} />
      </div>
      {propError && <ErrorBanner className="mb-6">Companies could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const l = lists[i];
        if (!l || l.error) return null;
        const companies = parseCompanies(l.data);
        const balances = balanceQs[i]?.error ? null : parseCreditBalances(balanceQs[i]?.data);
        const ptypes = roomTypes.filter((t) => t.property_id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {companies.length === 0 ? (
              <EmptyState className="mt-4">No company accounts yet.</EmptyState>
            ) : (
              companies.map((c) => (
                <div key={c.id}>
                  <form action={updateCompany} className="mt-4 grid gap-3 border border-line p-4 md:grid-cols-3">
                    <input type="hidden" name="companyId" value={c.id} />
                    <p className="text-sm md:col-span-3">
                      <strong>{c.name}</strong> · {c.groups} group(s){c.status === "archived" ? " · archived" : ""}
                      {" · "}Owes on open invoices {formatMoney(c.exposureMinor, p.currency)}
                      {c.creditLimitMinor !== null ? ` of ${formatMoney(c.creditLimitMinor, p.currency)} limit` : ""}
                      {c.overdueMinor > 0 ? ` · ${formatMoney(c.overdueMinor, p.currency)} overdue` : ""}
                    </p>
                    <label className="block text-sm">
                      Billing contact
                      <input name="contact" required maxLength={80} defaultValue={c.contact} className={`${inputClass} mt-1`} />
                    </label>
                    <label className="block text-sm">
                      Email
                      <input name="email" type="email" maxLength={120} defaultValue={c.email ?? ""} className={`${inputClass} mt-1`} />
                    </label>
                    <label className="block text-sm">
                      Phone
                      <input name="phone" type="tel" maxLength={30} defaultValue={c.phone ?? ""} className={`${inputClass} mt-1`} />
                    </label>
                    <label className="block text-sm">
                      Credit days (0 to 90)
                      <input
                        name="creditDays"
                        type="number"
                        min={0}
                        max={90}
                        defaultValue={c.creditDays}
                        className={`${inputClass} mt-1`}
                      />
                    </label>
                    <label className="block text-sm">
                      Agreed discount % (0 to 50)
                      <input
                        name="percent"
                        type="number"
                        min={0}
                        max={50}
                        step="0.01"
                        defaultValue={c.percent}
                        className={`${inputClass} mt-1`}
                      />
                    </label>
                    <label className="block text-sm">
                      Credit limit in {p.currency} (empty for none)
                      <input
                        name="creditLimit"
                        inputMode="decimal"
                        defaultValue={c.creditLimitMinor === null ? "" : minorToInput(c.creditLimitMinor)}
                        className={`${inputClass} mt-1`}
                      />
                    </label>
                    <label className="block text-sm">
                      Status
                      <select name="status" defaultValue={c.status} className={`${inputClass} mt-1`}>
                        <option value="active">Active</option>
                        <option value="archived">Archived</option>
                      </select>
                    </label>
                    <label className="block text-sm md:col-span-3">
                      Notes
                      <input name="notes" maxLength={500} defaultValue={c.notes ?? ""} className={`${inputClass} mt-1`} />
                    </label>
                    <div className="md:col-span-3">
                      <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                        Save
                      </PendingButton>
                    </div>
                  </form>
                  <div className="border border-t-0 border-line p-4 text-sm">
                    {balances && (
                      <div className="mb-4 border-b border-line pb-4">
                        <p>
                          <strong>Credit balance: {formatMoney(balances[c.id] ?? 0, p.currency)}</strong>
                          <span className="text-muted">
                            {" "}
                            Money the hotel holds for this company. Use it on the group page; it is not counted as income until it pays a
                            booking.
                          </span>
                        </p>
                        <form action={depositCompanyCredit} className="mt-2 flex flex-wrap items-end gap-3">
                          <input type="hidden" name="companyId" value={c.id} />
                          <input type="hidden" name="key" value={crypto.randomUUID()} />
                          <label className="block">
                            Amount received ({p.currency})
                            <input name="amount" required inputMode="decimal" className={`${inputClass} mt-1 w-36`} />
                          </label>
                          <label className="block">
                            How paid
                            <select name="method" defaultValue="bank_transfer" className={`${inputClass} mt-1`}>
                              {PAY_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {PAY_METHOD_LABEL[m]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block">
                            Reference
                            <input name="reference" maxLength={60} className={`${inputClass} mt-1 w-36`} />
                          </label>
                          <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                            Add to credit
                          </PendingButton>
                        </form>
                        {(balances[c.id] ?? 0) > 0 && (
                          <form action={withdrawCompanyCredit} className="mt-2 flex flex-wrap items-end gap-3">
                            <input type="hidden" name="companyId" value={c.id} />
                            <input type="hidden" name="key" value={crypto.randomUUID()} />
                            <label className="block">
                              Pay back or write off ({p.currency})
                              <input name="amount" required inputMode="decimal" className={`${inputClass} mt-1 w-36`} />
                            </label>
                            <label className="block">
                              Reason
                              <input name="reason" required maxLength={200} className={`${inputClass} mt-1 w-64`} />
                            </label>
                            <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                              Take out
                            </PendingButton>
                          </form>
                        )}
                        {(creditLedgers.get(c.id) ?? []).length > 0 && (
                          <ul className="mt-3 divide-y divide-line text-xs">
                            {(creditLedgers.get(c.id) ?? []).map((e, n) => (
                              <li key={n} className="flex flex-wrap justify-between gap-2 py-1">
                                <span>
                                  {e.createdAt.slice(0, 10)} · {CREDIT_KIND_LABEL[e.kind]}
                                  {e.groupName ? ` · ${e.groupName}` : ""}
                                  {e.reference ? ` · ${e.reference}` : ""}
                                </span>
                                <span className="tabular-nums">
                                  {e.amountMinor > 0 ? "+" : ""}
                                  {formatMoney(e.amountMinor, p.currency)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    <p className="text-muted">Agreed rates by room type (a room type without one uses the discount above).</p>
                    <ul className="mt-2 divide-y divide-line">
                      {c.rates.map((r) => (
                        <li key={r.roomTypeId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                          <span>
                            {r.roomTypeName}:{" "}
                            {r.mode === "fixed"
                              ? `${formatMoney(r.nightlyRateMinor ?? 0, p.currency)} a night before tax`
                              : `${r.percent}% off`}
                          </span>
                          <form action={removeCompanyRate}>
                            <input type="hidden" name="companyId" value={c.id} />
                            <input type="hidden" name="roomTypeId" value={r.roomTypeId} />
                            <PendingButton className={buttonQuiet} pendingLabel="Removing...">
                              Remove
                            </PendingButton>
                          </form>
                        </li>
                      ))}
                    </ul>
                    <form action={setCompanyAutoRate} className="mt-3 flex flex-wrap items-center gap-3">
                      <input type="hidden" name="companyId" value={c.id} />
                      <input type="hidden" name="on" value={c.autoApplyRate ? "false" : "true"} />
                      <span>
                        Apply when a booking is linked to the group: <strong>{c.autoApplyRate ? "on" : "off"}</strong>
                      </span>
                      <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                        {c.autoApplyRate ? "Turn off" : "Turn on"}
                      </PendingButton>
                    </form>
                    <form action={setCompanyReminders} className="mt-3 flex flex-wrap items-center gap-3">
                      <input type="hidden" name="companyId" value={c.id} />
                      <input type="hidden" name="on" value={c.remindOverdue ? "false" : "true"} />
                      <span>
                        Email overdue invoice reminders (up to 3, a week apart, to the email on the invoice):{" "}
                        <strong>{c.remindOverdue ? "on" : "off"}</strong>
                      </span>
                      <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                        {c.remindOverdue ? "Turn off" : "Turn on"}
                      </PendingButton>
                    </form>
                    <form action={setCompanyRate} className="mt-3 flex flex-wrap items-end gap-3">
                      <input type="hidden" name="companyId" value={c.id} />
                      <label className="block">
                        Room type
                        <select name="roomTypeId" required className={`${inputClass} mt-1`}>
                          {ptypes.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        Kind
                        <select name="mode" defaultValue="fixed" className={`${inputClass} mt-1`}>
                          <option value="fixed">Fixed nightly price ({p.currency})</option>
                          <option value="percent">Percent off</option>
                        </select>
                      </label>
                      <label className="block">
                        Amount or percent
                        <input name="value" required inputMode="decimal" className={`${inputClass} mt-1 w-36`} />
                      </label>
                      <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                        Set rate
                      </PendingButton>
                    </form>
                  </div>
                </div>
              ))
            )}

            <SectionTitle>New company</SectionTitle>
            <form action={createCompany} className="mt-3 grid gap-3 md:grid-cols-3">
              <input type="hidden" name="propertyId" value={p.id} />
              <label className="block text-sm md:col-span-3">
                Company name
                <input name="name" required maxLength={80} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Billing contact
                <input name="contact" required maxLength={80} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Email (optional)
                <input name="email" type="email" maxLength={120} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Phone (optional)
                <input name="phone" type="tel" maxLength={30} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Credit days (0 to 90)
                <input name="creditDays" type="number" min={0} max={90} defaultValue={0} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Agreed discount % (0 to 50)
                <input name="percent" type="number" min={0} max={50} step="0.01" defaultValue={0} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Credit limit in {p.currency} (empty for none)
                <input name="creditLimit" inputMode="decimal" className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm md:col-span-3">
                Notes (optional)
                <input name="notes" maxLength={500} className={`${inputClass} mt-1`} />
              </label>
              <div className="md:col-span-3">
                <PendingButton className={buttonPrimary} pendingLabel="Creating...">
                  Create company
                </PendingButton>
              </div>
            </form>
          </section>
        );
      })}
    </main>
  );
}
