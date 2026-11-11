import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import {
  buttonPrimary,
  buttonQuiet,
  EmptyState,
  headRow,
  inputClass,
  linkClass,
  PageTitle,
  SectionTitle,
  thRowHead,
} from "@/components/staff/ui";
import { PlatformNotice } from "@/components/platform-notice";
import {
  addDomain,
  applyPlan,
  markInvoicePaid,
  raiseInvoice,
  voidInvoice,
  resendOwnerInvite,
  setDomainVerified,
  setEntitlement,
  setProviderStatus,
  setSubscription,
  setTenantStatus,
} from "@/lib/platform/actions";
import { shortDate } from "@/lib/platform/hotel";
import { formatMoney } from "@/lib/guest-site/format";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Detail = {
  tenant: { id: string; name: string; slug: string; status: string; currency: string; created_at: string };
  properties: {
    id: string;
    name: string;
    code: string;
    city: string | null;
    state: string | null;
    timezone: string;
    currency: string;
    status: string;
  }[];
  domains: { id: string; host: string; property_id: string | null; is_primary: boolean; verified_at: string | null }[];
  payment_accounts: { id: string; provider: string; mode: string; label: string; secret_reference: string; status: string }[];
  owners: { user_id: string; email: string | null; status: string; accepted: boolean }[];
  subscription: { plan_code: string; status: string; trial_ends_at: string | null; current_period_end: string | null } | null;
  entitlements: { feature_key: string; enabled: boolean }[];
};

type Invoice = {
  id: string;
  number: string;
  plan_code: string | null;
  period_start: string;
  period_end: string;
  amount_minor: number;
  currency: string;
  status: "open" | "paid" | "void";
  due_date: string | null;
  note: string | null;
  paid_at: string | null;
  payment_ref: string | null;
  void_reason: string | null;
};

export default async function HotelDetail({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  if (!z.guid().safeParse(tenantId).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, level, planList, invoiceList] = await Promise.all([
    supabase.rpc("platform_tenant_detail", { p_tenant: tenantId }),
    supabase.rpc("platform_level"),
    supabase.rpc("platform_list_plans"),
    supabase.rpc("platform_list_invoices", { p_tenant: tenantId }),
  ]);
  const invoices = (invoiceList.data ?? []) as unknown as Invoice[];
  const plans = ((planList.data ?? []) as unknown as { code: string; name: string; active: boolean }[]).filter((p) => p.active);
  if (error || !data) notFound();
  const d = data as unknown as Detail;
  const admin = level.data === "admin";
  const t = d.tenant;
  const propName = new Map(d.properties.map((p) => [p.id, p.name]));

  return (
    <main className="max-w-4xl space-y-10">
      <div>
        <p className="text-sm">
          <Link href="/platform" className={linkClass}>
            All hotels
          </Link>
        </p>
        <PageTitle className="mt-2">{t.name}</PageTitle>
        <p className="mt-2 text-muted">
          {t.slug} · {t.status} · created {shortDate(t.created_at)}
        </p>
      </div>
      <PlatformNotice search={search} />

      <section aria-labelledby="props">
        <SectionTitle id="props">Properties</SectionTitle>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className={headRow}>
              <th scope="col" className={thRowHead}>
                Name
              </th>
              <th scope="col" className={thRowHead}>
                Code
              </th>
              <th scope="col" className={thRowHead}>
                Place
              </th>
              <th scope="col" className={thRowHead}>
                Time zone
              </th>
              <th scope="col" className={thRowHead}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {d.properties.map((p) => (
              <tr key={p.id} className="border-b border-line">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {p.name}
                </th>
                <td className="py-2 pr-3">{p.code}</td>
                <td className="py-2 pr-3">{[p.city, p.state].filter(Boolean).join(", ") || "-"}</td>
                <td className="py-2 pr-3">{p.timezone}</td>
                <td className="py-2 pr-3">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="owners">
        <SectionTitle id="owners">Owners</SectionTitle>
        {d.owners.length === 0 ? (
          <EmptyState className="mt-3">No owner.</EmptyState>
        ) : (
          <ul className="mt-3 border-t border-line">
            {d.owners.map((o) => (
              <li key={o.user_id} className="flex flex-wrap items-center gap-3 border-b border-line py-2 text-sm">
                <span>
                  {o.email ?? "Unknown"}{" "}
                  <span className="text-muted">
                    ({o.status}, {o.accepted ? "has signed up" : "invitation not accepted yet"})
                  </span>
                </span>
                {admin && !o.accepted && (
                  <form action={resendOwnerInvite} className="ml-auto">
                    <input type="hidden" name="tenantId" value={t.id} />
                    <input type="hidden" name="userId" value={o.user_id} />
                    <button type="submit" className={buttonQuiet}>
                      Send invitation again
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="domains">
        <SectionTitle id="domains">Booking addresses</SectionTitle>
        {d.domains.length === 0 ? (
          <EmptyState className="mt-3">No address.</EmptyState>
        ) : (
          <ul className="mt-3 border-t border-line">
            {d.domains.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2 text-sm">
                <span className="font-medium">{x.host}</span>
                <span className="text-muted">
                  {x.property_id ? (propName.get(x.property_id) ?? "") : "Whole group"} ·{" "}
                  {x.verified_at ? `verified ${shortDate(x.verified_at)}` : "not verified"}
                </span>
                {admin && (
                  <form action={setDomainVerified} className="ml-auto">
                    <input type="hidden" name="tenantId" value={t.id} />
                    <input type="hidden" name="domainId" value={x.id} />
                    <input type="hidden" name="verified" value={x.verified_at ? "false" : "true"} />
                    <button type="submit" className={x.verified_at ? buttonQuiet : buttonPrimary}>
                      {x.verified_at ? "Mark not verified" : "Mark verified"}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <form action={addDomain} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={t.id} />
            <div>
              <label htmlFor="host" className="block text-sm">
                Web address
              </label>
              <input id="host" name="host" required className={inputClass} />
            </div>
            <div>
              <label htmlFor="propertyId" className="block text-sm">
                Property
              </label>
              <select id="propertyId" name="propertyId" className={inputClass}>
                <option value="">Whole group</option>
                {d.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={buttonQuiet}>
              Add address
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="pay">
        <SectionTitle id="pay">Payment accounts</SectionTitle>
        {d.payment_accounts.length === 0 ? (
          <EmptyState className="mt-3">No payment account. The hotel cannot take online payments.</EmptyState>
        ) : (
          <ul className="mt-3 border-t border-line">
            {d.payment_accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2 text-sm">
                <span className="font-medium">
                  {a.provider} {a.mode}
                </span>
                <span className="text-muted">
                  {a.secret_reference} · {a.status}
                </span>
                {admin && (
                  <form action={setProviderStatus} className="ml-auto flex items-center gap-2">
                    <input type="hidden" name="tenantId" value={t.id} />
                    <input type="hidden" name="accountId" value={a.id} />
                    <label htmlFor={`s-${a.id}`} className="sr-only">
                      Status
                    </label>
                    <select id={`s-${a.id}`} name="status" defaultValue={a.status} className={inputClass}>
                      <option value="inactive">Inactive</option>
                      <option value="active">Active</option>
                      <option value="disabled">Disabled</option>
                    </select>
                    <button type="submit" className={buttonQuiet}>
                      Save
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sub">
        <SectionTitle id="sub">Plan and features</SectionTitle>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Seven flags are enforced. reports.export: turned off, the hotel's CSV downloads stop. online_payments: turned off, guests cannot
          start a card payment (payments already made, refunds and staff-recorded payments are unaffected). discounts: turned off, nobody at
          the hotel can give or change a discount (discounts already on bookings stay). online_booking: turned off, the guest website takes
          no new bookings (existing bookings, payments and staff-made reservations are unaffected). guest_cancel: turned off, guests cannot
          cancel from their booking link (staff still can). guest_changes: turned off, guests cannot edit their phone, send change requests
          or change dates from their booking link (staff still can, and can answer open requests). early_checkin: turned off, guests cannot
          be checked in before their arrival date (guests already checked in early and ordinary check-in are unaffected). With no row, or
          on, all seven work. Any other key is only recorded and switches nothing.
        </p>
        <p className="mt-3 text-sm">
          {d.subscription
            ? `${d.subscription.plan_code} (${d.subscription.status})${d.subscription.trial_ends_at ? `, trial ends ${shortDate(d.subscription.trial_ends_at)}` : ""}${d.subscription.current_period_end ? `, period ends ${shortDate(d.subscription.current_period_end)}` : ""}`
            : "No plan set."}
        </p>
        {admin && plans.length > 0 && (
          <form action={applyPlan} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={t.id} />
            <div>
              <label htmlFor="applyplan" className="block text-sm">
                Put this group on a plan
              </label>
              <select id="applyplan" name="plan" defaultValue={d.subscription?.plan_code ?? ""} className={inputClass}>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={buttonQuiet}>
              Apply plan
            </button>
            <p className="basis-full text-sm text-muted">
              Sets the plan code and turns the seven enforced flags on or off to match the plan. Use the form below to change only the
              status or dates.
            </p>
          </form>
        )}
        {admin && (
          <form action={setSubscription} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={t.id} />
            <div>
              <label htmlFor="plan" className="block text-sm">
                Plan code
              </label>
              <input id="plan" name="plan" required maxLength={40} defaultValue={d.subscription?.plan_code ?? ""} className={inputClass} />
            </div>
            <div>
              <label htmlFor="sstatus" className="block text-sm">
                Status
              </label>
              <select id="sstatus" name="status" defaultValue={d.subscription?.status ?? "trial"} className={inputClass}>
                <option value="trial">Trial</option>
                <option value="active">Active</option>
                <option value="past_due">Past due</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <label htmlFor="trialEnds" className="block text-sm">
                Trial ends
              </label>
              <input
                id="trialEnds"
                name="trialEnds"
                type="date"
                defaultValue={d.subscription?.trial_ends_at?.slice(0, 10) ?? ""}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="periodEnd" className="block text-sm">
                Period ends
              </label>
              <input
                id="periodEnd"
                name="periodEnd"
                type="date"
                defaultValue={d.subscription?.current_period_end?.slice(0, 10) ?? ""}
                className={inputClass}
              />
            </div>
            <button type="submit" className={buttonQuiet}>
              Save plan
            </button>
          </form>
        )}
        {d.entitlements.length > 0 && (
          <ul className="mt-4 border-t border-line">
            {d.entitlements.map((f) => (
              <li key={f.feature_key} className="flex items-center gap-3 border-b border-line py-2 text-sm">
                <span className="font-medium">{f.feature_key}</span>
                <span className="text-muted">{f.enabled ? "on" : "off"}</span>
                {admin && (
                  <form action={setEntitlement} className="ml-auto">
                    <input type="hidden" name="tenantId" value={t.id} />
                    <input type="hidden" name="key" value={f.feature_key} />
                    <input type="hidden" name="enabled" value={f.enabled ? "false" : "true"} />
                    <button type="submit" className={buttonQuiet}>
                      {f.enabled ? "Turn off" : "Turn on"}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <form action={setEntitlement} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={t.id} />
            <input type="hidden" name="enabled" value="true" />
            <div>
              <label htmlFor="fkey" className="block text-sm">
                New feature key
              </label>
              <input id="fkey" name="key" required maxLength={60} className={inputClass} />
            </div>
            <button type="submit" className={buttonQuiet}>
              Add and turn on
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="bill">
        <SectionTitle id="bill">Billing</SectionTitle>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Invoices to this group, raised and settled by hand: nothing is charged automatically. Mark one paid with the reference you saw (a
          bank transfer, for example). A paid invoice cannot be voided. Leave the amount empty to take the plan price, once that price is
          decided.
        </p>
        {invoices.length === 0 ? (
          <EmptyState className="mt-3">No invoices.</EmptyState>
        ) : (
          <ul className="mt-3 border-t border-line">
            {invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2 text-sm">
                <span className="font-medium">{i.number}</span>
                <span>{formatMoney(i.amount_minor, i.currency)}</span>
                <span className="text-muted">
                  {i.period_start} to {i.period_end}
                  {i.plan_code ? ` · ${i.plan_code}` : ""}
                  {i.due_date && i.status === "open" ? ` · due ${i.due_date}` : ""} ·{" "}
                  {i.status === "paid"
                    ? `paid ${shortDate(i.paid_at)} (${i.payment_ref})`
                    : i.status === "void"
                      ? `void: ${i.void_reason}`
                      : "open"}
                  {i.note ? ` · ${i.note}` : ""}
                </span>
                {admin && i.status === "open" && (
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <form action={markInvoicePaid} className="flex items-center gap-2">
                      <input type="hidden" name="tenantId" value={t.id} />
                      <input type="hidden" name="invoiceId" value={i.id} />
                      <label htmlFor={`ref-${i.id}`} className="sr-only">
                        Payment reference
                      </label>
                      <input id={`ref-${i.id}`} name="reference" required maxLength={120} placeholder="Reference" className={inputClass} />
                      <button type="submit" className={buttonPrimary}>
                        Mark paid
                      </button>
                    </form>
                    <form action={voidInvoice} className="flex items-center gap-2">
                      <input type="hidden" name="tenantId" value={t.id} />
                      <input type="hidden" name="invoiceId" value={i.id} />
                      <label htmlFor={`void-${i.id}`} className="sr-only">
                        Reason for voiding
                      </label>
                      <input
                        id={`void-${i.id}`}
                        name="reason"
                        required
                        minLength={3}
                        maxLength={500}
                        placeholder="Reason"
                        className={inputClass}
                      />
                      <button type="submit" className={buttonQuiet}>
                        Void
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <form action={raiseInvoice} className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={t.id} />
            <div>
              <label htmlFor="istart" className="block text-sm">
                Period starts
              </label>
              <input id="istart" name="start" type="date" required className={inputClass} />
            </div>
            <div>
              <label htmlFor="iend" className="block text-sm">
                Period ends
              </label>
              <input id="iend" name="end" type="date" required className={inputClass} />
            </div>
            <div>
              <label htmlFor="iamount" className="block text-sm">
                Amount (naira)
              </label>
              <input id="iamount" name="amount" inputMode="decimal" placeholder="Plan price" className={inputClass} />
            </div>
            <div>
              <label htmlFor="idue" className="block text-sm">
                Due
              </label>
              <input id="idue" name="due" type="date" className={inputClass} />
            </div>
            <div>
              <label htmlFor="inote" className="block text-sm">
                Note
              </label>
              <input id="inote" name="note" maxLength={300} className={inputClass} />
            </div>
            <button type="submit" className={buttonQuiet}>
              Raise invoice
            </button>
          </form>
        )}
      </section>

      {admin && (
        <section aria-labelledby="st">
          <SectionTitle id="st">Status</SectionTitle>
          <p className="mt-2 max-w-prose text-sm text-muted">
            Suspending or closing a hotel stops guests from booking online and payment webhooks from being accepted. It does not sign staff
            out. The reason is kept in the audit log.
          </p>
          <form action={setTenantStatus} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={t.id} />
            <div>
              <label htmlFor="status" className="block text-sm">
                New status
              </label>
              <select id="status" name="status" defaultValue={t.status} className={inputClass}>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div className="min-w-64 flex-1">
              <label htmlFor="reason" className="block text-sm">
                Reason
              </label>
              <input id="reason" name="reason" required minLength={3} maxLength={500} className={inputClass} />
            </div>
            <button type="submit" className={buttonQuiet}>
              Change status
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
