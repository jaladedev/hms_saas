import Link from "next/link";
import { ReportForm } from "@/components/staff/maintenance-bits";
import { buttonDanger, buttonPrimary, buttonQuiet, cardClass, inputClass, Notice, linkClass, ErrorBanner, EmptyState, PageIntro, PageTitle, RoomCardHeader, SectionTitle } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { historyByRoom, historyLine, type TaskRow } from "@/lib/staff/housekeeping-tasks";
import {
  faultLabel, faultsByRoom, historyByRoom as repairsByRoom, historyLine as repairLine, REQUEST_COLUMNS, type RequestRow,
} from "@/lib/staff/maintenance";
import { compareRoomNumbers, countStates, HOUSEKEEPING_STATUSES, roomViews, STATE_LABEL, type BoardClaim, type BoardRoom, type RoomState } from "@/lib/staff/room-board";
import { blockRoom, releaseBlock, setHousekeeping } from "@/lib/staff/room-actions";
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

export default async function RoomBoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [roomQ, propQ] = await Promise.all([
    // room_board_view (034): the rooms with their type's name and no rate, for everyone who holds room.view.
    supabase.from("room_board_view").select("id, property_id, room_type_id, room_type_name, room_number, floor, operational_status, housekeeping_status").limit(1000),
    supabase.from("properties").select("id, name, timezone"),
  ]);
  const rooms = (roomQ.data ?? []) as BoardRoom[];
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const now = new Date();
  const today = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  const loadError = Boolean(roomQ.error || propQ.error);
  const horizon = [...today.values()].sort()[0];

  // Claims that end today or later, so what is on each room now and next is known. room_board_claims_view (034) holds
  // live claims only, says whether the guest is in the room, and gives the booking link only to people who may read bookings.
  const claimQ = rooms.length && horizon
    ? await supabase.from("room_board_claims_view")
        .select("id, room_id, claim_type, start_date, end_date, reservation_room_id, block_reason, checked_in")
        .gt("end_date", horizon).limit(5000)
    : { data: [] };
  const claims = (claimQ.data ?? []) as BoardClaim[];

  const rrIds = [...new Set(claims.map((c) => c.reservation_room_id).filter((x): x is string => Boolean(x)))];
  // Guest and booking details need reservation.view. Without it the view gives no booking link (rrIds is empty), so
  // these reads are skipped and the board still shows occupied, arriving, held, blocked or vacant from the claims alone.
  const rrQ = rrIds.length ? await supabase.from("reservation_rooms").select("id, reservation_id").in("id", rrIds) : { data: [] };
  const rrRows = (rrQ.data ?? []) as { id: string; reservation_id: string }[];
  const resIds = [...new Set(rrRows.map((r) => r.reservation_id))];
  const resQ = resIds.length ? await supabase.from("reservations").select("id, booking_reference, primary_guest_id").in("id", resIds) : { data: [] };
  const reservations = new Map(((resQ.data ?? []) as { id: string; booking_reference: string; primary_guest_id: string }[]).map((r) => [r.id, r]));
  const resOfRr = new Map(rrRows.map((r) => [r.id, reservations.get(r.reservation_id)]));
  const guestIds = [...new Set([...reservations.values()].map((r) => r.primary_guest_id))];
  const guestQ = guestIds.length ? await supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] };
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));

  // Recent cleaning and other housekeeping tasks for each room's history. Readable with housekeeping.view; without it
  // this comes back empty and the history is simply not shown.
  const sinceTasks = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
  const taskQ = rooms.length
    ? await supabase.from("housekeeping_tasks")
        .select("id, property_id, room_id, task_type, status, priority, assigned_to, due_at, notes, completion_note, created_at, started_at, completed_at, cancel_reason, cancelled_at")
        .gte("created_at", sinceTasks).order("created_at", { ascending: false }).limit(1000)
    : { data: [] };
  const history = historyByRoom((taskQ.data ?? []) as TaskRow[]);
  const tzOf = new Map(properties.map((p) => [p.id, p.timezone]));

  // Repairs for each room: how many are open (the indicator) and the recent ones (the list). Readable with
  // maintenance.view or maintenance.manage; without either this comes back empty and nothing is shown.
  const repairQ = rooms.length
    ? await supabase.from("maintenance_requests").select(REQUEST_COLUMNS)
        .or(`status.in.(open,in_progress),created_at.gte.${sinceTasks}`).order("created_at", { ascending: false }).limit(1000)
    : { data: [] };
  const repairs = (repairQ.data ?? []) as RequestRow[];
  const faults = faultsByRoom(repairs);
  const repairHistory = repairsByRoom(repairs);

  // What the viewer may do at each property; the database checks again on every action.
  const can = new Map<string, { housekeeping: boolean; block: boolean; cancel: boolean; report: boolean }>();
  await Promise.all(properties.map(async (p) => {
    const [h, b, c, mv, mm] = await Promise.all([
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "housekeeping.update" }),
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "room.block" }),
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "reservation.cancel" }),
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "maintenance.view" }),
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "maintenance.manage" }),
    ]);
    can.set(p.id, { housekeeping: h.data === true, block: b.data === true, cancel: c.data === true, report: mv.data === true || mm.data === true });
  }));

  const views = roomViews(rooms, claims, new Set(), today)
    .sort((a, b) => compareRoomNumbers(a.room.room_number, b.room.room_number));
  const counts = countStates(views);
  const showProperty = properties.length > 1;
  const propName = new Map(properties.map((p) => [p.id, p.name]));

  const groups = new Map<string, typeof views>();
  for (const v of views) {
    const key = `${showProperty ? `${propName.get(v.room.property_id) ?? ""} · ` : ""}${v.room.room_type_name ?? "Rooms"}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }

  return (
    <main className="max-w-5xl">
      <PageTitle>Rooms</PageTitle>
      <PageIntro>What every room is doing today. Open a booking to check someone in or out.</PageIntro>
      <p className="mt-2 text-sm"><Link href="/app/rooms/calendar" className={linkClass}>Room calendar</Link></p>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <ErrorBanner className="mt-6">The rooms could not be loaded. Reload the page.</ErrorBanner>}

      {views.length > 0 && (
        <p className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label="Room totals">
          {(["occupied", "arriving", "held", "blocked", "out_of_service", "vacant"] as RoomState[]).filter((s) => counts[s] > 0).map((s) => (
            <span key={s}><span className="font-semibold tabular-nums">{counts[s]}</span> <span className="text-muted">{STATE_LABEL[s].toLowerCase()}</span></span>
          ))}
        </p>
      )}

      {!loadError && views.length === 0 && <EmptyState className="mt-6">No rooms to show. Rooms are added in the hotel setup.</EmptyState>}

      {[...groups].map(([title, items]) => (
        <section key={title} className="mt-10" aria-label={title}>
          <SectionTitle>{title} <span className="text-base text-muted">({items.length})</span></SectionTitle>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((v) => {
              const res = v.current?.reservation_room_id ? resOfRr.get(v.current.reservation_room_id) : undefined;
              const guest = res ? guests.get(res.primary_guest_id) : undefined;
              const nextRes = v.next?.reservation_room_id ? resOfRr.get(v.next.reservation_room_id) : undefined;
              return (
                <li key={v.room.id} className={cardClass}>
                  <RoomCardHeader roomNumber={v.room.room_number}>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${CHIP[v.state]}`}>{STATE_LABEL[v.state]}</span>
                  </RoomCardHeader>
                  <p className="mt-1 text-xs text-muted">
                    {v.room.floor !== null ? `Floor ${v.room.floor}, ` : ""}{HOUSEKEEPING[v.room.housekeeping_status] ?? v.room.housekeeping_status}
                  </p>
                  {faults.get(v.room.id) && (
                    <p className="mt-1 text-xs">
                      <Link href="/app/maintenance" className={`font-medium underline underline-offset-2 ${faults.get(v.room.id)?.top === "urgent" || faults.get(v.room.id)?.top === "high" ? "text-critical" : "text-pending"}`}>
                        {faultLabel(faults.get(v.room.id)!)}
                      </Link>
                    </p>
                  )}
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
                  {(history.get(v.room.id)?.length ?? 0) > 0 && (
                    <details className="mt-3 border-t border-line pt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary-strong">Housekeeping history</summary>
                      <ul className="mt-2 space-y-1 text-xs">
                        {history.get(v.room.id)!.map((t) => {
                          const line = historyLine(t, tzOf.get(t.property_id) ?? "UTC");
                          return (
                            <li key={t.id}>
                              <span className="font-medium">{line.title}</span>
                              {line.detail && <span className="block text-muted">{line.detail}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  )}
                  {(can.get(v.room.property_id)?.report || (repairHistory.get(v.room.id)?.length ?? 0) > 0) && (
                    <details className="mt-3 border-t border-line pt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary-strong">Repairs{(repairHistory.get(v.room.id)?.length ?? 0) > 0 ? ` (${repairHistory.get(v.room.id)!.length})` : ""}</summary>
                      {(repairHistory.get(v.room.id)?.length ?? 0) > 0 && (
                        <ul className="mt-2 space-y-1 text-xs">
                          {repairHistory.get(v.room.id)!.map((rq) => {
                            const line = repairLine(rq, tzOf.get(rq.property_id) ?? "UTC");
                            return (
                              <li key={rq.id}>
                                <Link href={`/app/maintenance/${rq.id}`} className="font-medium underline underline-offset-2">{line.title}</Link>
                                {line.detail && <span className="block text-muted">{line.detail}</span>}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {can.get(v.room.property_id)?.report && v.state !== "retired" && (
                        <div className="mt-3">
                          <p className="mb-2 text-xs font-medium">Report a fault in this room</p>
                          <ReportForm
                            properties={[{ id: v.room.property_id, name: propName.get(v.room.property_id) ?? "" }]}
                            rooms={[{ id: v.room.id, property_id: v.room.property_id, room_number: v.room.room_number, floor: v.room.floor }]}
                            from="rooms"
                            idempotencyKey={crypto.randomUUID()}
                            fixedRoomId={v.room.id}
                          />
                          <p className="mt-1 text-xs text-muted">This tells maintenance. It does not block the room.</p>
                        </div>
                      )}
                    </details>
                  )}
                  {(can.get(v.room.property_id)?.housekeeping || can.get(v.room.property_id)?.block) && v.state !== "retired" && (
                    <details className="mt-3 border-t border-line pt-2">
                      <summary className="cursor-pointer text-xs font-medium text-primary-strong">Manage</summary>
                      {can.get(v.room.property_id)?.housekeeping && (
                        <form action={setHousekeeping} className="mt-2 flex flex-wrap items-center gap-2">
                          <input type="hidden" name="roomId" value={v.room.id} />
                          <label htmlFor={`hk-${v.room.id}`} className="text-xs text-muted">Cleaning</label>
                          <select id={`hk-${v.room.id}`} name="status" defaultValue={v.room.housekeeping_status} className={`${inputClass} w-auto`}>
                            {HOUSEKEEPING_STATUSES.map((st) => <option key={st} value={st}>{HOUSEKEEPING[st]}</option>)}
                          </select>
                          <button type="submit" className={buttonQuiet}>Save</button>
                        </form>
                      )}
                      {can.get(v.room.property_id)?.block && v.state === "blocked" && v.current && (
                        <form action={releaseBlock} className="mt-3">
                          <input type="hidden" name="blockId" value={v.current.id} />
                          <button type="submit" className={buttonDanger}>Remove this block</button>
                        </form>
                      )}
                      {can.get(v.room.property_id)?.block && (
                        <form action={blockRoom} className="mt-3 grid gap-2">
                          <input type="hidden" name="roomId" value={v.room.id} />
                          <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                          <p className="text-xs font-medium">Block this room</p>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`bs-${v.room.id}`} className="block text-xs text-muted">From</label>
                              <input id={`bs-${v.room.id}`} name="start" type="date" required min={today.get(v.room.property_id)} defaultValue={today.get(v.room.property_id)} className={inputClass} />
                            </div>
                            <div>
                              <label htmlFor={`be-${v.room.id}`} className="block text-xs text-muted">Until (free again on)</label>
                              <input id={`be-${v.room.id}`} name="end" type="date" required className={inputClass} />
                            </div>
                          </div>
                          <label htmlFor={`br-${v.room.id}`} className="block text-xs text-muted">Reason</label>
                          <input id={`br-${v.room.id}`} name="reason" required maxLength={500} className={inputClass} />
                          <label htmlFor={`bx-${v.room.id}`} className="block text-xs text-muted">If bookings are in the way</label>
                          <select id={`bx-${v.room.id}`} name="resolution" defaultValue="fail" className={inputClass}>
                            <option value="fail">Do nothing and tell me</option>
                            <option value="move">Move them to other rooms of the same type</option>
                            {can.get(v.room.property_id)?.cancel && <option value="cancel">Cancel them (no charge; money paid goes to refunds)</option>}
                          </select>
                          <div><button type="submit" className={buttonPrimary}>Block room</button></div>
                        </form>
                      )}
                    </details>
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
