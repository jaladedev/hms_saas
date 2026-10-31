import Link from "next/link";
import { PaymentChip, ReservationChip } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { loadDeskRows, type DeskReservation } from "@/lib/staff/desk-query";
import { bucketFrontDesk, deskFlag, type DeskRow } from "@/lib/staff/front-desk";
import { nightsBetween, todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function FrontDeskPage() {
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, timezone");
  const properties = (props ?? []) as { id: string; name: string; timezone: string }[];
  const now = new Date();
  const todayByProperty = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  // The earliest "today" across properties bounds the query; bucketing then judges each row against its own property.
  const dates = [...todayByProperty.values()].sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  let rows: DeskReservation[] = [];
  let loadError = Boolean(propError);
  if (earliest && latest) {
    const loaded = await loadDeskRows(supabase, earliest, latest);
    loadError = loadError || Boolean(loaded.error);
    rows = loaded.rows;
  }

  const guestIds = [...new Set(rows.map((r) => r.primary_guest_id))];
  const guestQ = guestIds.length ? await supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] };
  // Guest names need guest.view; without it the row shows the booking reference only.
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const g = bucketFrontDesk(rows, todayByProperty);
  const showProperty = properties.length > 1;
  const propName = new Map(properties.map((p) => [p.id, p.name]));

  function Section({ title, hint, items, tone }: { title: string; hint?: string; items: DeskRow[]; tone?: "warn" }) {
    return (
      <section className="mt-10 first:mt-0" aria-labelledby={title.replace(/\W+/g, "-")}>
        <h2 id={title.replace(/\W+/g, "-")} className={`font-display text-xl ${tone === "warn" && items.length > 0 ? "text-critical" : ""}`}>
          {title} <span className="text-base text-muted">({items.length})</span>
        </h2>
        {hint && items.length > 0 && <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
        {items.length === 0 ? <p className="mt-2 text-sm text-muted">None.</p> : (
          <ul className="mt-2 border-t border-line">
            {items.map((r) => {
              const full = byId.get(r.id);
              const flag = deskFlag(r);
              return (
                <li key={`${title}-${r.id}`} className="border-b border-line">
                  <Link href={`/app/reservations/${r.id}`} className="grid gap-x-6 gap-y-1 py-3 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary md:grid-cols-[minmax(0,1fr)_12rem_auto]">
                    <div className="min-w-0">
                      <span className="font-medium">{r.booking_reference}</span>
                      <span className="ml-3 text-sm">{full ? guests.get(full.primary_guest_id) ?? "" : ""}</span>
                      {showProperty && <span className="ml-3 text-xs text-muted">{propName.get(r.property_id)}</span>}
                    </div>
                    <p className="text-sm text-muted md:text-right">
                      {formatDate(r.arrival_date)}, {nightsBetween(r.arrival_date, r.departure_date)} nights
                    </p>
                    <p className="flex flex-wrap items-center gap-2 md:justify-end">
                      <ReservationChip status={r.reservation_status} />
                      <PaymentChip status={r.payment_status} />
                      {flag === "Needs attention" && <span className="rounded bg-critical/10 px-2 py-0.5 text-xs font-medium text-critical">{flag}</span>}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );
  }

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Front desk</h1>
      <p className="mt-2 max-w-prose text-muted">
        Today{earliest ? `, ${formatDate(earliest)}` : ""}. Open a booking to check guests in or out.
      </p>

      {loadError && <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The front desk list could not be loaded. Reload the page.</p>}

      <div className="mt-8">
        <Section title="Overdue departures" hint="These guests are still marked in house past their departure date. Check them out or extend the stay." items={g.overdue} tone="warn" />
        <Section title="Arriving today" items={g.arrivals} />
        <Section title="Departing today" items={g.departures} />
        <Section title="Late arrivals" hint="Confirmed, expected before today, and not checked in yet." items={g.lateArrivals} tone="warn" />
        <Section title="In house" items={g.inHouse} />
      </div>
    </main>
  );
}
