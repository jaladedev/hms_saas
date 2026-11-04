import { ReconciliationForm } from "@/components/staff/reconciliation-form";
import { parseRange } from "@/lib/staff/reports";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Prop = { id: string; name: string; timezone: string };

export default async function ReconciliationPage() {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, timezone").order("name");
  const all = (propQ.data ?? []) as Prop[];
  // Needs payment.verify, and the ability to see money: the comparison reads payments through row level security,
  // and a payment the person cannot see would wrongly show up as missing.
  const allowed = (await Promise.all(all.map(async (p) => {
    const [verify, money] = await Promise.all([
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "payment.verify" }),
      supabase.rpc("can_view_money", { p_property: p.id }),
    ]);
    return verify.data === true && money.data === true ? p : null;
  }))).filter((p): p is Prop => p !== null);

  const heading = <h1 className="font-display text-3xl">Reconcile payments</h1>;
  if (propQ.error) return <main className="max-w-5xl">{heading}<p role="alert" className="mt-4 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The hotels could not be loaded. Refresh the page, and tell the owner if it keeps happening.</p></main>;
  if (allowed.length === 0) return <main className="max-w-5xl">{heading}<p className="mt-4 max-w-prose text-muted">Checking payments against Paystack is for the owner, general manager and accountant. Ask one of them if you need it.</p></main>;

  const range = parseRange(undefined, undefined, todayIn(allowed[0]!.timezone, new Date()));

  return (
    <main className="max-w-5xl">
      {heading}
      <p className="mt-2 max-w-prose text-muted">
        Compare Paystack&apos;s own record of the payments with what this system recorded, to catch a payment that was made but never confirmed here.
        In the Paystack Dashboard open Transactions, filter to the days you want, choose Export CSV and make sure the file includes the reference, amount and
        status columns. Then enter the same first and last day below. Nothing is changed by this page; it only lists differences for you to look at.
      </p>
      <div className="mt-6">
        <ReconciliationForm properties={allowed.map((p) => ({ id: p.id, name: p.name }))} defaultFrom={range.from} defaultTo={range.to} />
      </div>
    </main>
  );
}
