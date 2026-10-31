import { buttonPrimary, buttonQuiet, Notice } from "@/components/staff/ui";
import { buildWorklist, nextStatus, type WorkItem } from "@/lib/staff/housekeeping";
import { todayIn } from "@/lib/staff/reservations";
import { setHousekeeping } from "@/lib/staff/room-actions";
import type { BoardClaim, BoardRoom } from "@/lib/staff/room-board";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * What housekeeping staff need and nothing more: which rooms to clean, in what order, with one button per room.
 * It reads only rooms and inventory claims, so it works for roles that cannot see guests, bookings or rates.
 */
export default async function HousekeepingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
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

  const claimQ = rooms.length && horizon
    ? await supabase.from("room_inventory_claims")
        .select("id, room_id, claim_type, start_date, end_date, reservation_room_id, block_reason")
        .eq("status", "active").gte("end_date", horizon).limit(5000)
    : { data: [] };
  const claims = (claimQ.data ?? []) as BoardClaim[];

  const can = new Map<string, boolean>();
  await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "housekeeping.update" });
    can.set(p.id, data === true);
  }));

  const w = buildWorklist(rooms, claims, today);
  const showProperty = properties.length > 1;
  const propName = new Map(properties.map((p) => [p.id, p.name]));
  const total = w.urgent.length + w.toClean.length + w.inProgress.length;

  function Section({ title, hint, items }: { title: string; hint?: string; items: WorkItem[] }) {
    if (items.length === 0) return null;
    return (
      <section className="mt-8 first:mt-0" aria-label={title}>
        <h2 className="font-display text-xl">{title} <span className="text-base text-muted">({items.length})</span></h2>
        {hint && <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((i) => {
            const next = nextStatus(i.room.housekeeping_status);
            const tags = [
              i.arrivesToday && "Guest arrives today",
              i.departsToday && "Guest left today",
              !i.arrivesToday && i.bookedTonight && "Booked tonight",
              i.blockedToday && "Blocked today",
            ].filter(Boolean) as string[];
            return (
              <li key={i.room.id} className="rounded border border-line bg-white p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-semibold">{i.room.room_number}</span>
                  <span className="text-xs text-muted">
                    {i.room.floor !== null ? `Floor ${i.room.floor}` : ""}{showProperty ? `${i.room.floor !== null ? ", " : ""}${propName.get(i.room.property_id) ?? ""}` : ""}
                  </span>
                </div>
                {tags.length > 0 && <p className={`mt-1 text-xs ${i.arrivesToday ? "font-medium text-critical" : "text-muted"}`}>{tags.join(", ")}</p>}
                {next && can.get(i.room.property_id) && (
                  <form action={setHousekeeping} className="mt-3">
                    <input type="hidden" name="roomId" value={i.room.id} />
                    <input type="hidden" name="status" value={next.to} />
                    <input type="hidden" name="returnTo" value="/app/housekeeping" />
                    <button type="submit" className={next.to === "clean" ? buttonPrimary : buttonQuiet}>{next.label}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Housekeeping</h1>
      <p className="mt-2 max-w-prose text-muted">Rooms to clean today, most urgent first.</p>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <p role="alert" className="mb-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The rooms could not be loaded. Reload the page.</p>}

      {!loadError && rooms.length > 0 && (
        <p className="text-sm text-muted">
          {total === 0 ? "Nothing to clean right now." : `${total} ${total === 1 ? "room" : "rooms"} to go.`} {w.ready} {w.ready === 1 ? "room is" : "rooms are"} ready.
        </p>
      )}
      {!loadError && rooms.length === 0 && <p className="rounded border border-line bg-white px-4 py-6 text-muted">No rooms to show.</p>}

      <div className="mt-6">
        <Section title="Do first" hint="A guest arrives today and the room is not ready." items={w.urgent} />
        <Section title="To clean" items={w.toClean} />
        <Section title="Being cleaned" items={w.inProgress} />
      </div>
    </main>
  );
}
