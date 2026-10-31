import Link from "next/link";
import { formatDate } from "@/lib/guest-site/format";
import { loadDeskRows } from "@/lib/staff/desk-query";
import { bucketFrontDesk } from "@/lib/staff/front-desk";
import { buildTasks, countRefunds, todayFigures, type RefundBrief } from "@/lib/staff/overview";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = await createClient();
  const now = new Date();
  const [{ data: auth }, propQ] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("properties").select("id, name, timezone"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const todayByProperty = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  const dates = [...todayByProperty.values()].sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  // Each source is read on its own and may come back empty: row level security decides what this person can see,
  // and a failed read is reported at the top rather than shown as "all clear".
  const [desk, flaggedQ, refundQ, emailQ] = await Promise.all([
    earliest && latest ? loadDeskRows(supabase, earliest, latest) : Promise.resolve({ rows: [], error: null }),
    supabase.from("reservations").select("id", { count: "exact", head: true }).not("attention_reason", "is", null),
    supabase.from("refunds").select("refund_status, requested_by, attention_note, provider_call_started_at").in("refund_status", ["requested", "approved", "processing"]).limit(500),
    supabase.rpc("staff_failed_emails", { p_limit: 200 }),
  ]);

  const groups = bucketFrontDesk(desk.rows, todayByProperty);
  const refunds = countRefunds((refundQ.data ?? []) as RefundBrief[], auth.user?.id ?? null, now);
  const failedEmails = ((emailQ.data ?? []) as { state: string }[]).filter((e) => e.state === "failed").length;
  const tasks = buildTasks({ desk: groups, flaggedReservations: flaggedQ.count ?? 0, refunds, failedEmails });
  const figures = todayFigures(groups);
  const loadFailed = Boolean(propQ.error || desk.error || flaggedQ.error || refundQ.error);

  return (
    <main className="max-w-4xl">
      <h1 className="font-display text-3xl">Overview</h1>
      <p className="mt-2 text-muted">{earliest ? `Today, ${formatDate(earliest)}.` : "No property is visible to this account."}</p>

      {loadFailed && (
        <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">
          Part of this page could not be loaded, so the lists below may be incomplete. Reload the page.
        </p>
      )}

      <section className="mt-8" aria-labelledby="today">
        <h2 id="today" className="font-display text-xl">Today</h2>
        <dl className="mt-3 flex flex-wrap border-y border-line">
          {([["Arriving", figures.arriving], ["Departing", figures.departing], ["In house", figures.inHouse]] as const).map(([label, n], i) => (
            <div key={label} className={`min-w-32 flex-1 px-4 py-4 ${i > 0 ? "border-l border-line" : "pl-0"}`}>
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-sm"><Link href="/app/front-desk" className="text-primary-strong underline underline-offset-2">Open the front desk</Link></p>
      </section>

      <section className="mt-10" aria-labelledby="needs">
        <h2 id="needs" className="font-display text-xl">Needs a person</h2>
        {tasks.length === 0 ? (
          <p className="mt-3 rounded border border-line bg-white px-4 py-5 text-muted">
            {loadFailed ? "Nothing could be confirmed." : "Nothing is waiting on anyone."}
          </p>
        ) : (
          <ul className="mt-3 border-t border-line">
            {tasks.map((t) => (
              <li key={t.key} className="border-b border-line">
                <Link href={t.href} className="flex items-baseline gap-4 py-3 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary">
                  <span className={`w-10 text-right text-2xl font-semibold tabular-nums ${t.tone === "critical" ? "text-critical" : ""}`}>{t.count}</span>
                  <span>{t.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {refunds.waitingOnOthers > 0 && (
          <p className="mt-3 max-w-prose text-sm text-muted">
            {refunds.waitingOnOthers} {refunds.waitingOnOthers === 1 ? "refund you requested is" : "refunds you requested are"} waiting for a second person to approve.
          </p>
        )}
      </section>
    </main>
  );
}
