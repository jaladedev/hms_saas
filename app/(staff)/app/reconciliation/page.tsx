import { ReconciliationForm } from "@/components/staff/reconciliation-form";
import { parseRange } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { ErrorBanner, PageIntro, PageTitle } from "@/components/staff/ui";

export const dynamic = "force-dynamic";

type Prop = { id: string; name: string; timezone: string };

export default async function ReconciliationPage() {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, timezone").order("name");
  const all = (propQ.data ?? []) as Prop[];
  // Needs payment.verify, and the ability to see money: the comparison reads payments through row level security,
  // and a payment the person cannot see would wrongly show up as missing.
  const allowed = (
    await Promise.all(
      all.map(async (p) => {
        const [verify, money] = await Promise.all([
          supabase.rpc("has_permission", { p_property: p.id, p_permission: "payment.verify" }),
          supabase.rpc("can_view_money", { p_property: p.id }),
        ]);
        return verify.data === true && money.data === true ? p : null;
      }),
    )
  ).filter((p): p is Prop => p !== null);

  const heading = <PageTitle>Reconcile payments</PageTitle>;
  if (propQ.error)
    return (
      <main className="max-w-5xl">
        {heading}
        <ErrorBanner className="mt-4">
          The hotels could not be loaded. Refresh the page, and tell the owner if it keeps happening.
        </ErrorBanner>
      </main>
    );
  if (allowed.length === 0)
    return (
      <main className="max-w-5xl">
        {heading}
        <p className="mt-4 max-w-prose text-muted">
          Checking payments against Paystack is for the owner, general manager and accountant. Ask one of them if you need it.
        </p>
      </main>
    );

  const range = parseRange(undefined, undefined, todayIn(allowed[0]!.timezone, new Date()));

  return (
    <main className="max-w-5xl">
      {heading}
      <PageIntro>
        Compare Paystack&apos;s own record of the payments with what this system recorded, to catch a payment that was made but never
        confirmed here. In the Paystack Dashboard open Transactions, filter to the days you want, choose Export CSV and make sure the file
        includes the reference, amount and status columns. Then enter the same first and last day below. Nothing is changed by this page; it
        only lists differences for you to look at.
      </PageIntro>
      <div className="mt-6">
        <ReconciliationForm properties={allowed.map((p) => ({ id: p.id, name: p.name }))} defaultFrom={range.from} defaultTo={range.to} />
      </div>
    </main>
  );
}
