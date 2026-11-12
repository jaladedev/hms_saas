import { buttonPrimary, EmptyState, ErrorBanner, Notice, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { platformPaystackSecret } from "@/lib/platform/invoice-payment";
import { payInvoiceOnline } from "@/lib/staff/invoice-payment-actions";
import { formatMoney } from "@/lib/guest-site/format";
import { amountOwing, dueLabel, invoiceOverdue, type BillingInvoice } from "@/lib/staff/hotel-billing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Billing = { plan_code: string | null; invoices: BillingInvoice[] };

/**
 * What the platform has billed this hotel: the current plan and the invoices, read-only. Only people who may change the hotel setup
 * (property.configure) can read it; the database answers nobody else. Payment is arranged with the platform; this page only shows it.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const canPay = platformPaystackSecret() !== null;
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name").order("name");
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const results = await Promise.all(
    properties.map(async (p) => {
      const { data, error } = await supabase.rpc("hotel_billing", { p_property: p.id });
      return { p, billing: error ? null : (data as unknown as Billing), denied: !!error };
    }),
  );
  const visible = results.filter((r) => r.billing);
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();

  return (
    <main className="max-w-3xl">
      <PageTitle>Billing</PageTitle>
      <PageIntro>
        Your plan and the invoices from the platform. Open invoices can be paid online by card when the platform has switched that on; to
        pay another way or ask about an invoice, contact the platform with the invoice number.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {propQ.error && <ErrorBanner className="mt-6">The billing details could not be loaded. Reload the page.</ErrorBanner>}
      {!propQ.error && visible.length === 0 && (
        <EmptyState className="mt-6">Billing is shown to the hotel&rsquo;s owner and general manager.</EmptyState>
      )}
      {visible.map(({ p, billing }) => {
        // Invoices belong to the hotel group, so a group with several hotels would repeat them: show each list once.
        const key = (billing!.invoices.map((i) => i.id).join(",") || "none") + "|" + (billing!.plan_code ?? "");
        if (billing!.invoices.length > 0 && seen.has(key)) return null;
        seen.add(key);
        const owing = [...amountOwing(billing!.invoices)];
        return (
          <section key={p.id} className="mt-8" aria-label={p.name}>
            <SectionTitle>Plan</SectionTitle>
            <p className="mt-2 text-sm">
              {billing!.plan_code ? <span className="font-medium capitalize">{billing!.plan_code}</span> : "No plan has been set."}
            </p>
            {owing.length > 0 && (
              <p className="mt-2 text-sm">
                Owing: <span className="font-medium">{owing.map(([cur, minor]) => formatMoney(minor, cur)).join(", ")}</span>
              </p>
            )}
            <div className="mt-6">
              <SectionTitle>Invoices</SectionTitle>
            </div>
            {billing!.invoices.length === 0 ? (
              <EmptyState className="mt-3">No invoices yet.</EmptyState>
            ) : (
              <ul className="mt-3 border-t border-line">
                {billing!.invoices.map((i) => {
                  const due = dueLabel(i, today);
                  return (
                    <li key={i.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-3 text-sm">
                      <span className="font-medium">{i.number}</span>
                      <span className="tabular-nums">{formatMoney(i.amount_minor, i.currency)}</span>
                      <span className="text-muted">
                        {i.period_start} to {i.period_end}
                      </span>
                      <span className={invoiceOverdue(i, today) ? "font-medium text-critical" : "text-muted"}>
                        {i.status === "paid"
                          ? `Paid ${i.paid_at?.slice(0, 10) ?? ""}${i.payment_ref ? ` (${i.payment_ref})` : ""}`
                          : (due ?? "Open")}
                      </span>
                      {canPay && i.status === "open" && (
                        <form action={payInvoiceOnline} className="ml-auto">
                          <input type="hidden" name="propertyId" value={p.id} />
                          <input type="hidden" name="invoiceId" value={i.id} />
                          <button type="submit" className={buttonPrimary}>
                            Pay online
                          </button>
                        </form>
                      )}
                      {i.note && <span className="w-full text-xs text-muted">{i.note}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}
