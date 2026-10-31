import Link from "next/link";
import { formatDate } from "@/lib/guest-site/format";
import { compareRoomNumbers, countStates, roomViews, STATE_LABEL, type BoardClaim, type BoardRoom, type RoomState } from "@/lib/staff/room-board";
import { todayIn } from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CHIP: Record<RoomState, string> = {
  occupied: "bg-navy-800/10 text-navy-800",
  arriving: "bg-primary/10 text-primary-strong",
  held: "bg-pending/10 text-pending",
  blocked: "bg-critical/10 text-critical",
  out_of_service: "bg-critical/10 text-critical",
  retired: "bg-ink/10 text-muted",
  vacant: "bg-ink/10 text-ink",
};
const HOUSEKEEPING: Record<string, string> = { clean: "Clean", dirty: "Dirty", in_progress: "Being cleaned", inspected: "Inspected" };

export default async function RoomBoardPage() {
  const supabase = await createClient();
  const [roomQ, propQ] = await Promise.all([
    supabase.from("rooms").select("id, property_id, room_type_id, room_number, floor, operational_status, housekeeping_status").limit(1000),
    supabase.from("properties").select("id, name, timezone"),
  ]);
  const rooms = (roomQ.data ?? []) as BoardRoom[];
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const now = new Date();
  const today = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  const loadError = Boolean(roomQ.error || propQ.error);
  const horizon = [...today.values()].sort()[0];

  // Claims that end today or later, so what is on each room now and next is known.
  const claimQ = rooms.length && horizon
    ? await supabase.from("room_inventory_claims")
        .select("room_id, claim_type, start_date, end_date, reservation_room_id, block_reason")
        .eq("status", "active").gt("end_date", horizon).limit(5000)
    : { data: [] };
  const claims = (claimQ.data ?? []) as BoardClaim[];

  const rrIds = [...new Set(claims.map((c) => c.reservation_room_id).filter((x): x is string => Boolean(x)))];
  // Guest and booking details need reservation.view; without it the board still shows occupied or vacant.
  const rrQ = rrIds.length ? await supabase.from("reservation_rooms").select("id, reservation_id, room_status").in("id", rrIds) : { data: [] };
  const rrRows = (rrQ.data ?? []) as { id: string; reservation_id: string; room_status: string }[];
  const checkedIn = new Set(rrRows.filter((r) => r.room_status === "checked_in").map((r) => r.id));
  const resIds = [...new Set(rrRows.map((r) => r.reservation_id))];
  const resQ = resIds.length ? await supabase.from("reservations").select("id, booking_reference, primary_guest_id").in("id", resIds) : { data: [] };
  const reservations = new Map(((resQ.data ?? []) as { id: string; booking_reference: string; primary_guest_id: string }[]).map((r) => [r.id, r]));
  const resOfRr = new Map(rrRows.map((r) => [r.id, reservations.get(r.reservation_id)]));
  const guestIds = [...new Set([...reservations.values()].map((r) => r.primary_guest_id))];
  const guestQ = guestIds.length ? await supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] };
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));

  const typeIds = [...new Set(rooms.map((r) => r.room_type_id))];
  // Room types need reservation.view or rate.view; housekeeping and maintenance see rooms without type names.
  const typeQ = typeIds.length ? await supabase.from("room_types").select("id, name").in("id", typeIds) : { data: [] };
  const typeNames = new Map(((typeQ.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));

  const views = roomViews(rooms, claims, checkedIn, today)
    .sort((a, b) => compareRoomNumbers(a.room.room_number, b.room.room_number));
  const counts = countStates(views);
  const showProperty = properties.length > 1;
  const propName = new Map(properties.map((p) => [p.id, p.name]));

  const groups = new Map<string, typeof views>();
  for (const v of views) {
    const key = `${showProperty ? `${propName.get(v.room.property_id) ?? ""} · ` : ""}${typeNames.get(v.room.room_type_id) ?? "Rooms"}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Rooms</h1>
      <p className="mt-2 max-w-prose text-muted">What every room is doing today. Open a booking to check someone in or out.</p>

      {loadError && <p role="alert" className="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The rooms could not be loaded. Reload the page.</p>}

      {views.length > 0 && (
        <p className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Room totals">
          {(["occupied", "arriving", "held", "blocked", "out_of_service", "vacant"] as RoomState[]).filter((s) => counts[s] > 0).map((s) => (
            <span key={s}><span className="font-semibold tabular-nums">{counts[s]}</span> <span className="text-muted">{STATE_LABEL[s].toLowerCase()}</span></span>
          ))}
        </p>
      )}

      {!loadError && views.length === 0 && <p className="mt-6 rounded border border-line bg-white px-4 py-6 text-muted">No rooms to show. Rooms are added in the hotel setup.</p>}

      {[...groups].map(([title, items]) => (
        <section key={title} className="mt-10" aria-label={title}>
          <h2 className="font-display text-xl">{title} <span className="text-base text-muted">({items.length})</span></h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((v) => {
              const res = v.current?.reservation_room_id ? resOfRr.get(v.current.reservation_room_id) : undefined;
              const guest = res ? guests.get(res.primary_guest_id) : undefined;
              const nextRes = v.next?.reservation_room_id ? resOfRr.get(v.next.reservation_room_id) : undefined;
              return (
                <li key={v.room.id} className="rounded border border-line bg-white p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-semibold">{v.room.room_number}</span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${CHIP[v.state]}`}>{STATE_LABEL[v.state]}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {v.room.floor !== null ? `Floor ${v.room.floor}, ` : ""}{HOUSEKEEPING[v.room.housekeeping_status] ?? v.room.housekeeping_status}
                  </p>
                  {v.current && v.state !== "vacant" && (
                    <p className="mt-2 text-sm">
                      {v.current.claim_type === "block"
                        ? <>{v.current.block_reason}<span className="block text-xs text-muted">until {formatDate(v.current.end_date)}</span></>
                        : res
                          ? <><Link href={`/app/reservations/${res.id}`} className="font-medium text-primary-strong underline underline-offset-2">{res.booking_reference}</Link>{guest ? `, ${guest}` : ""}<span className="block text-xs text-muted">to {formatDate(v.current.end_date)}</span></>
                          : <span className="text-muted">until {formatDate(v.current.end_date)}</span>}
                    </p>
                  )}
                  {v.state === "out_of_service" && v.current && v.current.claim_type !== "block" && (
                    <p className="mt-2 text-xs text-critical">A booking is on this room. It needs moving.</p>
                  )}
                  {v.next && (v.state === "vacant" || v.state === "occupied") && (
                    <p className="mt-2 text-xs text-muted">
                      Next: {v.next.claim_type === "block" ? `blocked from ${formatDate(v.next.start_date)}` : (
                        <>{nextRes ? <Link href={`/app/reservations/${nextRes.id}`} className="underline underline-offset-2">{nextRes.booking_reference}</Link> : "booking"} from {formatDate(v.next.start_date)}</>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
