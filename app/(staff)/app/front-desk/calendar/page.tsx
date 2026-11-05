import Link from "next/link";
import { PrintButton } from "@/components/staff/print-button";
import { PrintHeader } from "@/components/staff/print-header";
import { buttonPrimary, inputClass, PaymentChip, ReservationChip, linkClass, ErrorBanner, EmptyState, PageIntro } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { AGENDA_LIMIT, AGENDA_STATUSES, agendaTotals, buildAgenda, busyDays, type AgendaRow } from "@/lib/staff/arrivals-calendar";
import { todayIn, nightsBetween } from "@/lib/staff/reservations";
import { dayHeads, parseWindow, shiftStart, WINDOW_CHOICES } from "@/lib/staff/room-calendar";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const COLUMNS = "id, property_id, booking_reference, primary_guest_id, reservation_status, payment_status, arrival_date, departure_date";

export default async function ArrivalsCalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name");
  const properties = (props ?? []) as { id: string; name: string; timezone: string }[];
  const property = properties.find((p) => p.id === search.property) ?? properties[0];
  const heading = <h1 className="font-display text-3xl">Arrivals and departures</h1>;
  const back = <p className="text-sm print:hidden"><Link href="/app/front-desk" className={linkClass}>Front desk</Link></p>;

  if (propError) {
    return <main className="max-w-5xl">{back}<div className="mt-2">{heading}</div><ErrorBanner className="mt-6">The calendar could not be loaded. Reload the page.</ErrorBanner></main>;
  }
  if (!property) {
    return <main className="max-w-5xl">{back}<div className="mt-2">{heading}</div><EmptyState className="mt-6">No hotel to show.</EmptyState></main>;
  }

  const today = todayIn(property.timezone, new Date());
  const w = parseWindow(search.from, search.days, today);
  // Bookings with an arrival or a departure in the window, or a night in it: arriving before the window ends and leaving on or after its first day.
  const resQ = await supabase.from("reservations").select(COLUMNS)
    .eq("property_id", property.id).in("reservation_status", [...AGENDA_STATUSES])
    .lt("arrival_date", w.end).gte("departure_date", w.start)
    .order("booking_reference").limit(AGENDA_LIMIT);
  const rows = (resQ.data ?? []) as AgendaRow[];
  const cut = rows.length >= AGENDA_LIMIT;

  // Guest names need guest.view; without it a row shows the booking number alone.
  const guestIds = [...new Set(rows.map((r) => r.primary_guest_id))];
  const guestQ = guestIds.length ? await supabase.from("guests").select("id, full_name").in("id", guestIds.slice(0, 500)) : { data: [] };
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));

  const days = buildAgenda(rows, w);
  const heads = dayHeads(w, today);
  const headOf = new Map(heads.map((h) => [h.date, h]));
  const busy = busyDays(days);
  const totals = agendaTotals(days);
  const qs = (over: Record<string, string>) => `?${new URLSearchParams({ property: property.id, from: w.start, days: String(w.days), ...over })}`;
  const lastNight = heads[heads.length - 1]!.date;
  const dayLabel = (date: string) => { const h = headOf.get(date)!; return `${h.weekday} ${h.day} ${h.month}`; };

  const List = ({ title, items }: { title: string; items: AgendaRow[] }) => (
    <div>
      <h3 className="text-sm font-medium text-muted">{title} <span className="tabular-nums">({items.length})</span></h3>
      {items.length === 0 ? <p className="mt-1 text-sm text-muted">None.</p> : (
        <ul className="mt-1 border-t border-line">
          {items.map((r) => (
            <li key={`${title}-${r.id}`} className="border-b border-line">
              <Link href={`/app/reservations/${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary">
                <span className="font-medium">{r.booking_reference}</span>
                <span className="text-sm">{guests.get(r.primary_guest_id) ?? ""}</span>
                <span className="text-sm text-muted">{formatDate(r.arrival_date)} to {formatDate(r.departure_date)}, {nightsBetween(r.arrival_date, r.departure_date)} {nightsBetween(r.arrival_date, r.departure_date) === 1 ? "night" : "nights"}</span>
                <span className="ml-auto flex flex-wrap items-center gap-2"><ReservationChip status={r.reservation_status} /><PaymentChip status={r.payment_status} /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <main className="max-w-5xl">
      {back}
      <div className="mt-2">{heading}</div>
      <PrintHeader hotel={property.name} from={w.start} to={lastNight} />
      <PageIntro>Who is due to arrive and leave on each day, and how many bookings have a night that day.</PageIntro>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 print:hidden">
        {properties.length > 1 && (
          <div>
            <label htmlFor="property" className="block text-sm">Property</label>
            <select id="property" name="property" defaultValue={property.id} className={inputClass}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="from" className="block text-sm">From</label>
          <input id="from" name="from" type="date" required defaultValue={w.start} className={inputClass} />
        </div>
        <div>
          <label htmlFor="days" className="block text-sm">Days</label>
          <select id="days" name="days" defaultValue={String(w.days)} className={inputClass}>
            {WINDOW_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button type="submit" className={buttonPrimary}>Show</button>
        <PrintButton />
      </form>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm print:hidden">
        <Link href={qs({ from: shiftStart(w, -1) })} className={linkClass}>Previous {w.days} days</Link>
        <Link href={qs({ from: today })} className={linkClass}>Today</Link>
        <Link href={qs({ from: shiftStart(w, 1) })} className={linkClass}>Next {w.days} days</Link>
      </p>

      {(resQ.error || cut) && (
        <p role={resQ.error ? "alert" : "status"} className={`mt-4 border-l-4 px-4 py-3 text-sm ${resQ.error ? "border-critical bg-critical/5 text-critical" : "border-pending bg-pending/5 text-pending"}`}>
          {resQ.error ? "The bookings could not be loaded. Reload the page." : `Only the first ${AGENDA_LIMIT} bookings are shown. Choose a shorter range.`}
        </p>
      )}

      <div className="mt-6 overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[22rem] text-sm print:min-w-0">
          <caption className="sr-only">Arrivals, departures and bookings staying, {property.name}, {w.start} to {lastNight}</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="py-2 pr-3 font-normal">Day</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Arriving</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Departing</th>
              <th scope="col" className="px-2 py-2 text-right font-normal">Staying</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const h = headOf.get(d.date)!;
              const quiet = d.arrivals.length === 0 && d.departures.length === 0;
              return (
                <tr key={d.date} className={`border-b border-line tabular-nums ${h.isToday ? "bg-primary/5" : h.isWeekend ? "bg-ink/5" : ""}`}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {quiet ? dayLabel(d.date) : <a href={`#d-${d.date}`} className={linkClass}>{dayLabel(d.date)}</a>}
                    {h.isToday && <span className="ml-2 text-xs text-primary-strong">Today</span>}
                  </th>
                  <td className="px-2 py-2 text-right">{d.arrivals.length || "–"}</td>
                  <td className="px-2 py-2 text-right">{d.departures.length || "–"}</td>
                  <td className="px-2 py-2 text-right">{d.staying || "–"}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-semibold tabular-nums">
              <th scope="row" className="py-2 pr-3 text-left">{w.days} days</th>
              <td className="px-2 py-2 text-right">{totals.arrivals}</td>
              <td className="px-2 py-2 text-right">{totals.departures}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-10 space-y-10">
        {busy.length === 0 && !resQ.error && <EmptyState>Nobody is due to arrive or leave in these {w.days} days.</EmptyState>}
        {busy.map((d) => (
          <section key={d.date} id={`d-${d.date}`} aria-labelledby={`h-${d.date}`} className="scroll-mt-4">
            <h2 id={`h-${d.date}`} className="font-display text-xl">
              {dayLabel(d.date)}{headOf.get(d.date)!.isToday && <span className="ml-2 text-base text-primary-strong">Today</span>}
            </h2>
            <div className="mt-3 grid gap-6 md:grid-cols-2 print:grid-cols-1">
              <List title="Arriving" items={d.arrivals} />
              <List title="Departing" items={d.departures} />
            </div>
          </section>
        ))}
      </div>

      <ul className="mt-10 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted">
        <li>Cancelled and no-show bookings are left out. A hold (pending) is listed so you see it coming but is not counted as staying.</li>
        <li>Staying is the number of bookings with a night on that day; the departure day is not a night. A booking with several rooms counts once.</li>
        <li>Guest names show only to people who may see guests.</li>
      </ul>
    </main>
  );
}
