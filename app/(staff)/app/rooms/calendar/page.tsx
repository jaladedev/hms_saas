import Link from "next/link";
import { CalendarDrag } from "@/components/staff/calendar-drag";
import { buttonPrimary, inputClass, Notice, linkClass, ErrorBanner, EmptyState, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { canMoveBar } from "@/lib/staff/calendar-move";
import { bookFromCalendarHref } from "@/lib/staff/new-reservation";
import type { BoardClaim, BoardRoom } from "@/lib/staff/room-board";
import { buildRows, dayHeads, KIND_LABEL, nightTotals, parseWindow, shiftStart, WINDOW_CHOICES, type Bar } from "@/lib/staff/room-calendar";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";

export const dynamic = "force-dynamic";

const BAR: Record<Bar["kind"], string> = {
  occupied: "bg-navy-800 text-white",
  arriving: "bg-primary/15 text-primary-strong ring-1 ring-primary/40",
  held: "bg-pending/15 text-pending ring-1 ring-pending/40",
  blocked: "bg-critical/15 text-critical ring-1 ring-critical/40",
};

type Search = Record<string, string | string[] | undefined>;

export default async function RoomCalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [roomQ, propQ] = await Promise.all([
    // The same two views as the room board (migration 039): no rates, and booking links only for people who may read bookings.
    supabase.from("room_board_view").select("id, property_id, room_type_id, room_type_name, room_number, floor, operational_status, housekeeping_status").limit(1000),
    supabase.from("properties").select("id, name, timezone").eq("status", "active").order("name"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const allRooms = (roomQ.data ?? []) as BoardRoom[];
  const withRooms = properties.filter((p) => allRooms.some((r) => r.property_id === p.id));
  const property = pickProperty(withRooms, typeof search.property === "string" ? search.property : undefined, await rememberedProperty());
  const heading = <PageTitle>Room calendar</PageTitle>;

  if (roomQ.error || propQ.error) {
    return <main className="max-w-5xl">{heading}<ErrorBanner className="mt-6">The calendar could not be loaded. Reload the page.</ErrorBanner></main>;
  }
  if (!property) {
    return <main className="max-w-5xl">{heading}<EmptyState className="mt-6">No rooms to show. Rooms are added in the hotel setup.</EmptyState></main>;
  }

  const today = todayIn(property.timezone, new Date());
  const w = parseWindow(search.from, search.days, today);
  const rooms = allRooms.filter((r) => r.property_id === property.id);
  const claimQ = await supabase.from("room_board_claims_view")
    .select("id, room_id, claim_type, start_date, end_date, reservation_room_id, block_reason, checked_in")
    .eq("property_id", property.id).lt("start_date", w.end).gt("end_date", w.start).limit(5000);
  const claims = (claimQ.data ?? []) as BoardClaim[];

  // Booking numbers and guest names, only where the viewer's permissions let the database return them (the view gives
  // no reservation_room_id without reservation.view, and guests need guest.view); otherwise the bars carry the kind alone.
  const rrIds = [...new Set(claims.map((c) => c.reservation_room_id).filter((x): x is string => Boolean(x)))];
  const rrQ = rrIds.length ? await supabase.from("reservation_rooms").select("id, reservation_id").in("id", rrIds) : { data: [] };
  const rrRows = (rrQ.data ?? []) as { id: string; reservation_id: string }[];
  const resIds = [...new Set(rrRows.map((r) => r.reservation_id))];
  const resQ = resIds.length ? await supabase.from("reservations").select("id, booking_reference, primary_guest_id").in("id", resIds) : { data: [] };
  const reservations = new Map(((resQ.data ?? []) as { id: string; booking_reference: string; primary_guest_id: string }[]).map((r) => [r.id, r]));
  const resOfRr = new Map(rrRows.map((r) => [r.id, reservations.get(r.reservation_id)]));
  const guestIds = [...new Set([...reservations.values()].map((r) => r.primary_guest_id))];
  const guestQ = guestIds.length ? await supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] };
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));

  // An empty night links to a new booking only for people who may create bookings here (the database checks again on submit).
  const { data: canBookHere } = await supabase.rpc("has_permission", { p_property: property.id, p_permission: "reservation.create" });
  const canBook = canBookHere === true;
  const { data: canAssignHere } = await supabase.rpc("has_permission", { p_property: property.id, p_permission: "room.assign" });
  const canMove = canAssignHere === true;

  const heads = dayHeads(w, today);
  const rows = buildRows(rooms, claims, w);
  const totals = nightTotals(rows, w);
  const qs = (over: Record<string, string>) => `?${new URLSearchParams({ property: property.id, from: w.start, days: String(w.days), ...over })}`;
  const lastNight = heads[heads.length - 1]!.date;

  return (
    <main>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm"><Link href="/app/rooms" className={linkClass}>Room board</Link><Link href="/app/front-desk/calendar" className={linkClass}>Arrivals and departures</Link></p>
      <div className="mt-2">{heading}</div>
      <PageIntro>
        Every room for the nights ahead. A stay covers the nights it is booked for; the departure day is free for the next guest.
      </PageIntro>

      <div className="mt-4"><Notice search={search} currency="NGN" /></div>

      <form method="get" className="mt-2 flex flex-wrap items-end gap-3">
        {withRooms.length > 1 && (
          <div>
            <label htmlFor="property" className="block text-sm">Property</label>
            <select id="property" name="property" defaultValue={property.id} className={inputClass}>
              {withRooms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="from" className="block text-sm">From</label>
          <input id="from" name="from" type="date" required defaultValue={w.start} className={inputClass} />
        </div>
        <div>
          <label htmlFor="days" className="block text-sm">Nights</label>
          <select id="days" name="days" defaultValue={String(w.days)} className={inputClass}>
            {WINDOW_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button type="submit" className={buttonPrimary}>Show</button>
      </form>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={qs({ from: shiftStart(w, -1) })} className={linkClass}>Previous {w.days} nights</Link>
        <Link href={qs({ from: today })} className={linkClass}>Today</Link>
        <Link href={qs({ from: shiftStart(w, 1) })} className={linkClass}>Next {w.days} nights</Link>
      </p>

      <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Key">
        {(Object.keys(KIND_LABEL) as Bar["kind"][]).map((k) => (
          <span key={k} className="flex items-center gap-1.5"><span className={`inline-block h-3 w-5 rounded-sm ${BAR[k]}`} aria-hidden="true" />{KIND_LABEL[k]}</span>
        ))}
      </p>

      <div id="room-calendar" className="relative mt-4 overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs" style={{ minWidth: `${9 + w.days * 3}rem` }}>
          <caption className="sr-only">Rooms of {property.name} from {w.start} to {lastNight}</caption>
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 w-36 min-w-36 border-b border-line bg-white py-2 pr-3 text-left font-normal text-muted">Room</th>
              {heads.map((h) => (
                <th key={h.date} scope="col" className={`border-b border-l border-line px-0.5 py-1 text-center font-normal ${h.isToday ? "bg-primary/10 text-primary-strong" : h.isWeekend ? "bg-ink/5 text-muted" : "text-muted"}`}>
                  {h.monthStart && <span className="block text-[10px] uppercase tracking-wide">{h.month}</span>}
                  <span className="block tabular-nums">{h.day}</span>
                  <span className="block">{h.weekday}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={w.days + 1} className="px-3 py-6 text-muted">No rooms to show.</td></tr>}
            {rows.map((row, i) => {
              const cells: React.ReactNode[] = [];
              let col = 1;
              const showType = i === 0 || rows[i - 1]!.room.room_type_name !== row.room.room_type_name;
              while (col <= w.days) {
                const bar = row.bars.find((b) => b.column === col);
                if (!bar) {
                  const h = heads[col - 1]!;
                  const bookable = canBook && row.room.operational_status === "active" && h.date >= today;
                  cells.push(
                    <td key={`e${col}`} data-date={h.date} className={`h-9 border-b border-l border-line p-0 ${h.isToday ? "bg-primary/5" : h.isWeekend ? "bg-ink/5" : ""}`}>
                      {bookable && (
                        <Link href={bookFromCalendarHref(row.room.id, h.date)} className="block h-9 w-full hover:bg-primary/15 focus-visible:bg-primary/15">
                          <span className="sr-only">Book room {row.room.room_number} from {formatDate(h.date)}</span>
                        </Link>
                      )}
                    </td>,
                  );
                  col += 1;
                  continue;
                }
                const res = bar.claim.reservation_room_id ? resOfRr.get(bar.claim.reservation_room_id) : undefined;
                const movable = Boolean(res) && canMoveBar(bar.claim, today, canMove);
                const guest = res ? guests.get(res.primary_guest_id) : undefined;
                const label = bar.claim.claim_type === "block" ? (bar.claim.block_reason ?? KIND_LABEL.blocked) : res ? res.booking_reference : KIND_LABEL[bar.kind];
                const detail = `${KIND_LABEL[bar.kind]}${guest ? `, ${guest}` : ""}: ${formatDate(bar.claim.start_date)} to ${formatDate(bar.claim.end_date)}`;
                cells.push(
                  <td key={bar.claim.id} colSpan={bar.span} data-date={heads[col - 1]!.date} className="h-9 border-b border-l border-line p-0.5">
                    {res ? (
                      <Link href={`/app/reservations/${res.id}`} title={detail}
                        {...(movable ? {
                          draggable: true, "data-move-rr": bar.claim.reservation_room_id!, "data-move-room": row.room.id, "data-move-type": row.room.room_type_id,
                          "data-move-room-number": row.room.room_number, "data-move-label": res.booking_reference, "data-move-start": bar.claim.start_date, "data-move-end": bar.claim.end_date,
                        } : {})}
                        className={`${movable ? "cursor-grab " : ""}block truncate rounded px-1.5 py-1.5 font-medium ${BAR[bar.kind]} ${bar.continuesBefore ? "rounded-l-none" : ""} ${bar.continuesAfter ? "rounded-r-none" : ""}`}>
                        {bar.continuesBefore && <span aria-hidden="true">‹ </span>}{label}{guest ? ` · ${guest}` : ""}{bar.continuesAfter && <span aria-hidden="true"> ›</span>}
                      </Link>
                    ) : (
                      <span title={detail} className={`block truncate rounded px-1.5 py-1.5 font-medium ${BAR[bar.kind]} ${bar.continuesBefore ? "rounded-l-none" : ""} ${bar.continuesAfter ? "rounded-r-none" : ""}`}>
                        {bar.continuesBefore && <span aria-hidden="true">‹ </span>}{label}{bar.continuesAfter && <span aria-hidden="true"> ›</span>}
                      </span>
                    )}
                  </td>,
                );
                col += bar.span;
              }
              return (
                <tr key={row.room.id} data-room-id={row.room.id} data-room-type={row.room.room_type_id} data-room-number={row.room.room_number} data-room-status={row.room.operational_status} className={row.room.operational_status === "out_of_service" ? "opacity-70" : ""}>
                  <th scope="row" className="sticky left-0 z-10 w-36 min-w-36 border-b border-line bg-white py-1 pr-3 text-left font-normal">
                    <span className="font-semibold">{row.room.room_number}</span>
                    {showType && row.room.room_type_name && <span className="ml-2 text-muted">{row.room.room_type_name}</span>}
                    {row.room.operational_status === "out_of_service" && <span className="ml-2 rounded bg-critical/10 px-1 text-critical">Out of service</span>}
                  </th>
                  {cells}
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <th scope="row" className="sticky left-0 z-10 bg-white py-2 pr-3 text-left font-semibold">Rooms booked</th>
                {totals.map((t) => (
                  <td key={t.date} className="border-l border-line px-0.5 py-2 text-center font-semibold tabular-nums" title={`${t.stays} of ${t.sellable} sellable rooms`}>{t.stays}</td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {canMove && <CalendarDrag containerId="room-calendar" today={today} property={property.id} from={w.start} days={w.days} />}

      <ul className="mt-6 max-w-prose list-disc space-y-1 pl-5 text-sm text-muted">
        {canBook && <li>Select an empty night to start a booking for that room. The form opens with the room and the night filled in; change the departure there.</li>}
        {canMove && <li>To move a guest, drag their bar onto another room of the same room type and confirm. Dropping on a night moves the stay from that night; elsewhere on the row moves what is left of it. Drag works with a mouse; on a phone, open the booking and use &ldquo;Move to another room&rdquo;.</li>}
        <li>Bars are drawn from the booked claims on each room. A booking number and guest name show only to people who may see bookings and guests; everyone else sees the kind of claim.</li>
        <li>Rooms booked counts rooms with a stay that night. Holds and blocks are not stays. Retired rooms are left out.</li>
      </ul>
    </main>
  );
}
