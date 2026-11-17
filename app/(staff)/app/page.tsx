import Link from "next/link";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { barPercent, recentReservations, weekStrip } from "@/lib/staff/dashboard";
import { loadDeskRows } from "@/lib/staff/desk-query";
import { formatBp } from "@/lib/staff/occupancy";
import { bucketFrontDesk } from "@/lib/staff/front-desk";
import {
  buildTasks,
  countCleaning,
  countRefunds,
  countRepairs,
  todayFigures,
  type RefundBrief,
  type RequestBrief,
  type RoomBrief,
} from "@/lib/staff/overview";
import { PAYMENT_LABEL, STATUS_LABEL, todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { linkClass, ErrorBanner, PageTitle, SectionTitle } from "@/components/staff/ui";

export const dynamic = "force-dynamic";

/** The date n days after an ISO date (UTC arithmetic, so no daylight saving to worry about). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when the signed-in user holds at least one of the permissions at any of the properties. A failed check counts as no. */
async function anyPermission(
  supabase: Awaited<ReturnType<typeof createClient>>,
  propertyIds: string[],
  permissions: string[],
): Promise<boolean> {
  const checks = propertyIds.flatMap((id) => permissions.map((p) => supabase.rpc("has_permission", { p_property: id, p_permission: p })));
  const results = await Promise.all(checks);
  return results.some((r) => r.data === true);
}

export default async function Dashboard() {
  const supabase = await createClient();
  const now = new Date();
  const [{ data: auth }, propQ] = await Promise.all([supabase.auth.getUser(), supabase.from("properties").select("id, name, timezone")]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const todayByProperty = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  const dates = [...todayByProperty.values()].sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  // Each source is read on its own and may come back empty: row level security decides what this person can see,
  // and a failed read is reported at the top rather than shown as "all clear".
  const [desk, flaggedQ, refundQ, emailQ, repairQ, canSeeRepairs, roomQ, canSeeCleaning, strips, recentQ, canSeeReservations] =
    await Promise.all([
      earliest && latest ? loadDeskRows(supabase, earliest, latest) : Promise.resolve({ rows: [], error: null }),
      supabase.from("reservations").select("id", { count: "exact", head: true }).not("attention_reason", "is", null),
      supabase
        .from("refunds")
        .select("refund_status, requested_by, attention_note, provider_call_started_at")
        .in("refund_status", ["requested", "approved", "processing"])
        .limit(500),
      supabase.rpc("staff_failed_emails", { p_limit: 200 }),
      // A thin read of live requests; row level security returns only what this person may see (maintenance.view or manage).
      supabase
        .from("maintenance_requests")
        .select("status, priority, assigned_to, due_at")
        .in("status", ["open", "in_progress"])
        .limit(500),
      // The repair figure is shown only to people who can read requests, so "0 open" is never shown to a role that sees none.
      anyPermission(
        supabase,
        properties.map((p) => p.id),
        ["maintenance.view", "maintenance.manage"],
      ),
      // Rooms not yet clean: two status columns only. Shown only to people who can open housekeeping, for the same reason.
      supabase
        .from("rooms")
        .select("housekeeping_status, operational_status")
        .in("housekeeping_status", ["dirty", "in_progress"])
        .limit(1000),
      anyPermission(
        supabase,
        properties.map((p) => p.id),
        ["housekeeping.view", "housekeeping.update"],
      ),
      // Occupancy for today and the next six days, one read per hotel. Only people with report.view get an answer; the others get
      // NOT_FOUND, which simply leaves the strip out.
      Promise.all(
        properties.map((p) => {
          const from = todayByProperty.get(p.id) ?? "";
          return supabase.rpc("occupancy_report", { p_property_id: p.id, p_from: from, p_to: addDays(from, 6) });
        }),
      ),
      // The latest bookings; row level security returns only what this person may read.
      supabase
        .from("reservations")
        .select("id, booking_reference, reservation_status, payment_status, total_minor, currency, arrival_date, primary_guest_id")
        .order("created_at", { ascending: false })
        .limit(6),
      anyPermission(
        supabase,
        properties.map((p) => p.id),
        ["reservation.view"],
      ),
    ]);
  const week = strips.map((r) => weekStrip(r.error ? null : r.data)).filter((w): w is NonNullable<typeof w> => w !== null);
  const recent = canSeeReservations ? recentReservations(recentQ.data) : [];
  const recentGuestIds = [...new Set(recent.map((r) => r.primary_guest_id).filter((g): g is string => !!g))];
  const guestQ = recentGuestIds.length ? await supabase.from("guests").select("id, full_name").in("id", recentGuestIds) : { data: [] };
  const guestName = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));
  const propertyName = new Map(properties.map((p) => [p.id, p.name]));

  const groups = bucketFrontDesk(desk.rows, todayByProperty);
  const refunds = countRefunds((refundQ.data ?? []) as RefundBrief[], auth.user?.id ?? null, now);
  const repairs = countRepairs((repairQ.data ?? []) as RequestBrief[], now);
  const cleaning = countCleaning((roomQ.data ?? []) as RoomBrief[]);
  const failedEmails = ((emailQ.data ?? []) as { state: string }[]).filter((e) => e.state === "failed").length;
  const tasks = buildTasks({ desk: groups, flaggedReservations: flaggedQ.count ?? 0, refunds, repairs, failedEmails });
  const figures = todayFigures(groups);
  const loadFailed = Boolean(propQ.error || desk.error || flaggedQ.error || refundQ.error || repairQ.error || roomQ.error);

  return (
    <main className="max-w-6xl">
      <PageTitle>Overview</PageTitle>
      <p className="mt-2 text-muted">{earliest ? `Today, ${formatDate(earliest)}.` : "No property is visible to this account."}</p>

      {loadFailed && (
        <ErrorBanner className="mt-6">
          Part of this page could not be loaded, so the lists below may be incomplete. Reload the page.
        </ErrorBanner>
      )}

      <section className="mt-8" aria-labelledby="today">
        <SectionTitle id="today">Today</SectionTitle>
        <dl className="mt-3 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {(
            [
              ["Arriving", figures.arriving],
              ["Departing", figures.departing],
              ["In house", figures.inHouse],
              ...(canSeeRepairs ? ([["Open repairs", repairs.open]] as const) : []),
              ...(canSeeCleaning ? ([["Rooms to clean", cleaning.total]] as const) : []),
            ] as readonly (readonly [string, number])[]
          ).map(([label, n]) => (
            <div key={label} className="rounded-2xl border border-line bg-white p-5">
              <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
              <dd className="mt-2 text-3xl font-semibold tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-sm">
          <Link href="/app/front-desk" className={linkClass}>
            Open the front desk
          </Link>
          {canSeeCleaning && (
            <>
              {" · "}
              <Link href="/app/housekeeping" className={linkClass}>
                Open housekeeping
              </Link>
            </>
          )}
          {canSeeRepairs && (
            <>
              {" · "}
              <Link href="/app/maintenance" className={linkClass}>
                Open maintenance
              </Link>
            </>
          )}
        </p>
      </section>

      <div className="mt-10 grid items-start gap-6 lg:grid-cols-3">
        {recent.length > 0 && (
          <section className="rounded-2xl border border-line bg-white p-5 lg:col-span-2" aria-labelledby="recent">
            <SectionTitle id="recent">Recent reservations</SectionTitle>
            <ul className="mt-3 border-t border-line">
              {recent.map((r) => (
                <li key={r.id} className="border-b border-line">
                  <Link href={`/app/reservations/${r.id}`} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3 hover:bg-paper">
                    <span className="w-36 whitespace-nowrap font-medium">{r.booking_reference}</span>
                    <span className="min-w-32 flex-1">{r.primary_guest_id ? (guestName.get(r.primary_guest_id) ?? "Guest") : "Guest"}</span>
                    <span className="text-sm text-muted">
                      {STATUS_LABEL[r.reservation_status] ?? r.reservation_status} · {PAYMENT_LABEL[r.payment_status] ?? r.payment_status}
                    </span>
                    <span className="tabular-nums">{formatMoney(r.total_minor, r.currency)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              <Link href="/app/reservations" className={linkClass}>
                All reservations
              </Link>
            </p>
          </section>
        )}

        <div className="space-y-6">
          <section className="rounded-2xl border border-line bg-white p-5" aria-labelledby="needs">
            <SectionTitle id="needs">Needs a person</SectionTitle>
            {tasks.length === 0 ? (
              <p className="mt-3 rounded border border-line bg-white px-4 py-5 text-muted">
                {loadFailed ? "Nothing could be confirmed." : "Nothing is waiting on anyone."}
              </p>
            ) : (
              <ul className="mt-3 border-t border-line">
                {tasks.map((t) => (
                  <li key={t.key} className="border-b border-line">
                    <Link
                      href={t.href}
                      className="flex items-baseline gap-4 py-3 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <span
                        className={`w-10 text-right text-2xl font-semibold tabular-nums ${t.tone === "critical" ? "text-critical" : ""}`}
                      >
                        {t.count}
                      </span>
                      <span>{t.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {refunds.waitingOnOthers > 0 && (
              <p className="mt-3 max-w-prose text-sm text-muted">
                {refunds.waitingOnOthers} {refunds.waitingOnOthers === 1 ? "refund you requested is" : "refunds you requested are"} waiting
                for a second person to approve.
              </p>
            )}
          </section>
          {week.length > 0 && (
            <section className="rounded-2xl border border-line bg-white p-5" aria-labelledby="occupancy">
              <SectionTitle id="occupancy">Occupancy</SectionTitle>
              {week.map((w) => (
                <div key={w.propertyId} className="mt-3">
                  {week.length > 1 && <p className="text-sm font-medium">{propertyName.get(w.propertyId)}</p>}
                  <p className="mt-1">
                    <span className="text-3xl font-semibold tabular-nums">{formatBp(w.today.bp)}</span>{" "}
                    <span className="text-sm text-muted">
                      tonight: {w.today.sold} of {w.today.available} rooms sold, {w.today.free} free
                    </span>
                  </p>
                  <ol aria-label="Occupancy for the next seven days" className="mt-3 flex h-20 items-end gap-2">
                    {w.days.map((d) => (
                      <li key={d.date} className="flex h-full flex-1 flex-col justify-end text-center">
                        <div
                          className="rounded-t bg-primary/70"
                          style={{ height: `${barPercent(d.bp)}%` }}
                          title={`${formatDate(d.date)}: ${formatBp(d.bp)} (${d.sold} of ${d.available})`}
                        />
                      </li>
                    ))}
                  </ol>
                  <ol className="mt-1 flex gap-2 text-xs text-muted" aria-hidden="true">
                    {w.days.map((d) => (
                      <li key={d.date} className="flex-1 text-center tabular-nums">
                        {new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
              <p className="mt-2 text-sm">
                <Link href="/app/reports/occupancy" className={linkClass}>
                  Open the occupancy report
                </Link>
              </p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
