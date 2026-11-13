import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { cardClass, EmptyState, linkClass, PageTitle, SectionTitle } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { historyLine, type TaskRow } from "@/lib/staff/housekeeping-tasks";
import { historyLine as repairLine, REQUEST_COLUMNS, type RequestRow } from "@/lib/staff/maintenance";
import { statusEventLine, type StatusEvent } from "@/lib/staff/room-status-history";
import { roomViews, STATE_LABEL, type BoardClaim, type BoardRoom, type RoomState } from "@/lib/staff/room-board";
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

type TypeRow = {
  name: string;
  description: string | null;
  amenities: string[] | null;
  max_adults: number;
  max_children: number;
  max_occupancy: number;
};

/**
 * One room: what it is (type, floor, what the type offers), what it is doing now and next, and its recent history. It reads
 * only what the board reads, so a person without reservation.view sees the state but no guest, and one without
 * housekeeping or maintenance access sees no history for those; nothing here changes anything.
 */
export default async function RoomDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const supabase = await createClient();

  const { data: roomRow } = await supabase
    .from("room_board_view")
    .select("id, property_id, room_type_id, room_type_name, room_number, floor, operational_status, housekeeping_status")
    .eq("id", id)
    .maybeSingle();
  if (!roomRow) notFound();
  const room = roomRow as BoardRoom;

  const [propQ, typeQ] = await Promise.all([
    supabase.from("properties").select("name, timezone").eq("id", room.property_id).maybeSingle(),
    supabase
      .from("room_types")
      .select("name, description, amenities, max_adults, max_children, max_occupancy")
      .eq("id", room.room_type_id)
      .maybeSingle(),
  ]);
  const tz = (propQ.data as { timezone: string } | null)?.timezone ?? "UTC";
  const type = (typeQ.data ?? null) as TypeRow | null;
  const today = todayIn(tz, new Date());

  const claimQ = await supabase
    .from("room_board_claims_view")
    .select("id, room_id, claim_type, start_date, end_date, reservation_room_id, block_reason, checked_in")
    .eq("room_id", room.id)
    .gt("end_date", today)
    .order("start_date")
    .limit(20);
  const claims = (claimQ.data ?? []) as BoardClaim[];
  const view = roomViews([room], claims, new Set(), new Map([[room.property_id, today]]))[0]!;

  // Guest and booking: only when the view gave a booking link, which needs reservation.view.
  async function bookingOf(rrId: string | null | undefined) {
    if (!rrId) return null;
    const { data: rr } = await supabase.from("reservation_rooms").select("reservation_id").eq("id", rrId).maybeSingle();
    if (!rr) return null;
    const { data: res } = await supabase
      .from("reservations")
      .select("id, booking_reference, primary_guest_id")
      .eq("id", (rr as { reservation_id: string }).reservation_id)
      .maybeSingle();
    if (!res) return null;
    const r = res as { id: string; booking_reference: string; primary_guest_id: string };
    const { data: g } = await supabase.from("guests").select("full_name").eq("id", r.primary_guest_id).maybeSingle();
    return { id: r.id, ref: r.booking_reference, guest: (g as { full_name: string } | null)?.full_name ?? null };
  }
  const [current, next] = await Promise.all([bookingOf(view.current?.reservation_room_id), bookingOf(view.next?.reservation_room_id)]);

  const [eventQ, taskQ, repairQ] = await Promise.all([
    supabase.rpc("room_status_history", { p_room: room.id, p_limit: 20 }),
    supabase
      .from("housekeeping_tasks")
      .select(
        "id, property_id, room_id, task_type, status, priority, assigned_to, due_at, notes, completion_note, created_at, started_at, completed_at, cancel_reason, cancelled_at",
      )
      .eq("room_id", room.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("maintenance_requests")
      .select(REQUEST_COLUMNS)
      .eq("room_id", room.id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  const events = (eventQ.data ?? []) as StatusEvent[];
  const tasks = (taskQ.data ?? []) as TaskRow[];
  const repairs = (repairQ.data ?? []) as RequestRow[];
  const amenities = type?.amenities ?? [];

  return (
    <main className="max-w-3xl">
      <p className="text-sm">
        <Link href="/app/rooms" className={linkClass}>
          Back to the room board
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <PageTitle>Room {room.room_number}</PageTitle>
        <span className={`rounded px-2 py-0.5 text-sm font-medium ${CHIP[view.state]}`}>{STATE_LABEL[view.state]}</span>
      </div>

      <dl className={`${cardClass} mt-5 grid gap-4 text-sm sm:grid-cols-2`}>
        <div>
          <dt className="text-muted">Room type</dt>
          <dd className="font-medium">{type?.name ?? room.room_type_name ?? "Not shown"}</dd>
        </div>
        <div>
          <dt className="text-muted">Floor</dt>
          <dd className="font-medium">{room.floor !== null ? room.floor : "Not set"}</dd>
        </div>
        <div>
          <dt className="text-muted">Booking status</dt>
          <dd className="font-medium">{STATE_LABEL[view.state]}</dd>
        </div>
        <div>
          <dt className="text-muted">Housekeeping</dt>
          <dd className="font-medium">{HOUSEKEEPING[room.housekeeping_status] ?? room.housekeeping_status}</dd>
        </div>
        {type && (
          <div className="sm:col-span-2">
            <dt className="text-muted">Sleeps</dt>
            <dd className="font-medium">
              Up to {type.max_adults} {type.max_adults === 1 ? "adult" : "adults"}
              {type.max_children > 0 ? `, ${type.max_children} ${type.max_children === 1 ? "child" : "children"}` : ""},{" "}
              {type.max_occupancy} in all
            </dd>
          </div>
        )}
      </dl>

      {type?.description && <p className="mt-4 max-w-prose text-sm text-muted">{type.description}</p>}

      <section className="mt-8" aria-label="Amenities">
        <SectionTitle>Amenities</SectionTitle>
        {amenities.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {amenities.map((a) => (
              <li key={a} className="rounded-full border border-line bg-white px-3 py-1">
                {a}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState className="mt-3">No amenities are listed for this room type.</EmptyState>
        )}
        <p className="mt-2 text-xs text-muted">
          These belong to the room type. They are chosen under{" "}
          <Link href="/app/settings/rooms" className={linkClass}>
            Room types and rooms
          </Link>
          .
        </p>
      </section>

      <section className="mt-8" aria-label="Now and next">
        <SectionTitle>Current reservation</SectionTitle>
        {view.current ? (
          <div className={`${cardClass} mt-3 text-sm`}>
            {view.current.claim_type === "block" ? (
              <>
                {view.current.block_reason ?? "Blocked"} <span className="text-muted">until {formatDate(view.current.end_date)}</span>
              </>
            ) : current ? (
              <>
                <Link href={`/app/reservations/${current.id}`} className="font-medium text-primary-strong underline underline-offset-2">
                  {current.ref}
                </Link>
                {current.guest ? `, ${current.guest}` : ""}
                <span className="text-muted">
                  {" "}
                  · {formatDate(view.current.start_date)} to {formatDate(view.current.end_date)}
                </span>
              </>
            ) : (
              <span className="text-muted">
                {STATE_LABEL[view.state]} until {formatDate(view.current.end_date)}
              </span>
            )}
          </div>
        ) : (
          <EmptyState className="mt-3">Nobody is booked into this room today.</EmptyState>
        )}
        {view.next && (
          <p className="mt-2 text-sm text-muted">
            Next:{" "}
            {view.next.claim_type === "block" ? (
              `blocked from ${formatDate(view.next.start_date)}`
            ) : (
              <>
                {next ? (
                  <Link href={`/app/reservations/${next.id}`} className={linkClass}>
                    {next.ref}
                  </Link>
                ) : (
                  "a booking"
                )}
                {next?.guest ? `, ${next.guest}` : ""} from {formatDate(view.next.start_date)}
              </>
            )}
          </p>
        )}
      </section>

      <section className="mt-8" aria-label="Status history">
        <SectionTitle>Status history</SectionTitle>
        {events.length === 0 ? (
          <EmptyState className="mt-3">No status changes have been recorded for this room yet.</EmptyState>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {events.map((e, i) => {
              const line = statusEventLine(e, tz);
              return (
                <li key={`${e.changed_at}-${i}`} className="border-b border-line pb-2">
                  <span className="font-medium">{line.title}</span>
                  <span className="block text-xs text-muted">{line.detail}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-label="Cleaning tasks">
        <SectionTitle>Cleaning tasks</SectionTitle>
        {tasks.length === 0 ? (
          <EmptyState className="mt-3">No cleaning tasks to show.</EmptyState>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {tasks.map((t) => {
              const line = historyLine(t, tz);
              return (
                <li key={t.id} className="border-b border-line pb-2">
                  <span className="font-medium">{line.title}</span>
                  {line.detail && <span className="block text-xs text-muted">{line.detail}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-8" aria-label="Repairs">
        <SectionTitle>Repairs</SectionTitle>
        {repairs.length === 0 ? (
          <EmptyState className="mt-3">No repairs on record for this room.</EmptyState>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {repairs.map((r) => {
              const line = repairLine(r, tz);
              return (
                <li key={r.id} className="border-b border-line pb-2">
                  <Link href={`/app/maintenance/${r.id}`} className="font-medium underline underline-offset-2">
                    {line.title}
                  </Link>
                  {line.detail && <span className="block text-xs text-muted">{line.detail}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
