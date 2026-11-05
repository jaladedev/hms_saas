import { buttonDanger, buttonPrimary, buttonQuiet, inputClass, Notice, ErrorBanner, PageIntro } from "@/components/staff/ui";
import { assignTask, cancelTask, claimTask, completeTask, createTask, startTask } from "@/lib/staff/housekeeping-actions";
import {
  activityByRoom, actionsFor, filterByPerson, formatDue, groupLive, PRIORITY_LABEL, recentlyDone, roomsWithoutTask, sortTasks,
  TASK_PRIORITIES, TASK_TYPE_LABEL, TASK_TYPES, type RoomActivity, type TaskRow,
} from "@/lib/staff/housekeeping-tasks";
import { todayIn } from "@/lib/staff/reservations";
import type { BoardClaim, BoardRoom } from "@/lib/staff/room-board";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Staff = { user_id: string; full_name: string };

const TASK_COLUMNS = "id, property_id, room_id, task_type, status, priority, assigned_to, due_at, notes, completion_note, created_at, started_at, completed_at";
const PRIORITY_CHIP: Record<string, string> = {
  urgent: "bg-critical/10 text-critical", high: "bg-pending/10 text-pending", normal: "bg-ink/10 text-muted", low: "bg-ink/5 text-muted",
};

/**
 * Housekeeping on tasks: my work, work nobody has yet, work with others, and what was finished lately. It reads
 * rooms, claims and tasks only (no guests, bookings or rates), so it works for every role that may see housekeeping.
 * Buttons mirror the database rules; the database still decides.
 */
export default async function HousekeepingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();

  const [userQ, roomQ, propQ, liveQ, doneQ] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("rooms").select("id, property_id, room_type_id, room_number, floor, operational_status, housekeeping_status").limit(1000),
    supabase.from("properties").select("id, name, timezone"),
    supabase.from("housekeeping_tasks").select(TASK_COLUMNS).in("status", ["open", "in_progress"]).limit(500),
    supabase.from("housekeeping_tasks").select(TASK_COLUMNS).eq("status", "done").gte("completed_at", since).order("completed_at", { ascending: false }).limit(100),
  ]);
  const userId = userQ.data.user?.id ?? "";
  const rooms = (roomQ.data ?? []) as BoardRoom[];
  const properties = (propQ.data ?? []) as { id: string; name: string; timezone: string }[];
  const live = (liveQ.data ?? []) as TaskRow[];
  const done = recentlyDone((doneQ.data ?? []) as TaskRow[], now);
  const loadError = Boolean(roomQ.error || propQ.error || liveQ.error || doneQ.error);

  const today = new Map(properties.map((p) => [p.id, todayIn(p.timezone, now)]));
  const horizon = [...today.values()].sort()[0];
  const claimQ = rooms.length && horizon
    ? await supabase.from("room_inventory_claims")
        .select("id, room_id, claim_type, start_date, end_date, reservation_room_id, block_reason")
        .eq("status", "active").gte("end_date", horizon).limit(5000)
    : { data: [] };
  const claims = (claimQ.data ?? []) as BoardClaim[];

  // Permissions are per property; supervisors also need the names of the people they can hand work to.
  const canWork = new Map<string, boolean>();
  const canAssign = new Map<string, boolean>();
  const staff = new Map<string, Staff[]>();
  await Promise.all(properties.map(async (p) => {
    const [upd, asg] = await Promise.all([
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "housekeeping.update" }),
      supabase.rpc("has_permission", { p_property: p.id, p_permission: "housekeeping.assign" }),
    ]);
    canWork.set(p.id, upd.data === true);
    canAssign.set(p.id, asg.data === true);
    if (asg.data === true) {
      const { data } = await supabase.rpc("list_housekeeping_staff", { p_property: p.id });
      staff.set(p.id, (data ?? []) as Staff[]);
    }
  }));

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const activity = activityByRoom(rooms, claims, today);
  const tz = new Map(properties.map((p) => [p.id, p.timezone]));
  const propName = new Map(properties.map((p) => [p.id, p.name]));
  const showProperty = properties.length > 1;
  const anySupervisor = [...canAssign.values()].some(Boolean);
  const people = new Map<string, string>();
  for (const list of staff.values()) for (const s of list) people.set(s.user_id, s.full_name);
  const whoParam = search.who;
  const who = anySupervisor && typeof whoParam === "string" ? whoParam : "";
  const groups = groupLive(filterByPerson(sortTasks(live, roomById, activity), who, userId), userId);
  const orphans = roomsWithoutTask(rooms, live).filter((r) => canWork.get(r.property_id));
  const createRooms = rooms
    .filter((r) => r.operational_status !== "retired" && canWork.get(r.property_id))
    .sort((a, b) => a.property_id.localeCompare(b.property_id) || (a.floor ?? 99) - (b.floor ?? 99) || a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));

  const whoHas = (t: TaskRow): string => {
    if (t.assigned_to === null) return "Nobody yet";
    if (t.assigned_to === userId) return "You";
    return staff.get(t.property_id)?.find((s) => s.user_id === t.assigned_to)?.full_name ?? "Someone else";
  };

  function TaskCard({ t }: { t: TaskRow }) {
    const room = roomById.get(t.room_id);
    const act: RoomActivity | undefined = activity.get(t.room_id);
    const a = actionsFor(t, userId, canWork.get(t.property_id) === true, canAssign.get(t.property_id) === true);
    const due = formatDue(t.due_at, tz.get(t.property_id) ?? "UTC", now);
    const tags = [act?.arrivesToday && "Guest arrives today", act?.departsToday && "Guest left today", act?.blockedToday && "Blocked today"].filter(Boolean) as string[];
    const people = staff.get(t.property_id) ?? [];
    return (
      <li className="rounded border border-line bg-white p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-lg font-semibold">{room?.room_number ?? "Room"}</span>
          <span className="text-xs text-muted">
            {room?.floor != null ? `Floor ${room.floor}` : ""}{showProperty ? `${room?.floor != null ? ", " : ""}${propName.get(t.property_id) ?? ""}` : ""}
          </span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium">{TASK_TYPE_LABEL[t.task_type] ?? t.task_type}</span>
          <span className={`rounded px-1.5 py-0.5 font-medium ${PRIORITY_CHIP[t.priority] ?? PRIORITY_CHIP.normal}`}>{PRIORITY_LABEL[t.priority] ?? t.priority}</span>
          {t.status === "in_progress" && <span className="rounded bg-navy-800/10 px-1.5 py-0.5 font-medium text-navy-800">In progress</span>}
        </p>
        {tags.length > 0 && <p className={`mt-1 text-xs ${act?.arrivesToday ? "font-medium text-critical" : "text-muted"}`}>{tags.join(", ")}</p>}
        {due && <p className={`mt-1 text-xs ${due.overdue ? "font-medium text-critical" : "text-muted"}`}>{due.text}</p>}
        {t.notes && <p className="mt-1 text-sm">{t.notes}</p>}
        <p className="mt-1 text-xs text-muted">With: {whoHas(t)}</p>

        {(a.claim || a.start || a.complete) && (
          <div className="mt-3 flex flex-wrap items-start gap-2">
            {a.claim && (
              <form action={claimTask}>
                <input type="hidden" name="taskId" value={t.id} />
                <button type="submit" className={buttonQuiet}>Take it</button>
              </form>
            )}
            {a.start && (
              <form action={startTask}>
                <input type="hidden" name="taskId" value={t.id} />
                <button type="submit" className={buttonQuiet}>Start</button>
              </form>
            )}
            {a.complete && (
              <form action={completeTask} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="taskId" value={t.id} />
                <input name="note" maxLength={500} placeholder="Note (optional)" aria-label={`Note for room ${room?.room_number ?? ""}`} className={`${inputClass} w-40`} />
                <button type="submit" className={buttonPrimary}>Done</button>
              </form>
            )}
          </div>
        )}

        {a.assign && (
          <form action={assignTask} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="taskId" value={t.id} />
            <select name="userId" defaultValue={t.assigned_to ?? ""} aria-label={`Assign room ${room?.room_number ?? ""}`} className={`${inputClass} w-40`}>
              <option value="">Nobody</option>
              {people.map((s) => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}
            </select>
            <button type="submit" className={buttonQuiet}>Assign</button>
          </form>
        )}

        {a.cancel && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted underline underline-offset-2">Cancel this task</summary>
            <form action={cancelTask} className="mt-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="taskId" value={t.id} />
              <input name="reason" required maxLength={200} placeholder="Reason" aria-label="Reason for cancelling" className={`${inputClass} w-40`} />
              <button type="submit" className={buttonDanger}>Cancel task</button>
            </form>
          </details>
        )}
      </li>
    );
  }

  function Section({ title, hint, items }: { title: string; hint?: string; items: TaskRow[] }) {
    if (items.length === 0) return null;
    return (
      <section className="mt-8 first:mt-0" aria-label={title}>
        <h2 className="font-display text-xl">{title} <span className="text-base text-muted">({items.length})</span></h2>
        {hint && <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.map((t) => <TaskCard key={t.id} t={t} />)}</ul>
      </section>
    );
  }

  const liveCount = groups.mine.length + groups.unassigned.length + groups.others.length;

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Housekeeping</h1>
      <PageIntro>Tasks to do, most urgent first.</PageIntro>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {loadError && <ErrorBanner className="mb-6">The tasks could not be loaded. Reload the page.</ErrorBanner>}

      {!loadError && (
        <p className="text-sm text-muted">
          {liveCount === 0 ? "No open tasks right now." : `${liveCount} ${liveCount === 1 ? "task" : "tasks"} to go.`}
          {groups.mine.length > 0 && ` ${groups.mine.length} ${groups.mine.length === 1 ? "is" : "are"} yours.`}
        </p>
      )}

      {anySupervisor && (
        <form method="get" className="mb-4 flex flex-wrap items-center gap-2" aria-label="Filter tasks">
          <label htmlFor="who" className="text-sm text-muted">Show</label>
          <select id="who" name="who" defaultValue={who} className={`${inputClass} w-auto`}>
            <option value="">Everyone's tasks</option>
            <option value="me">Mine</option>
            <option value="unassigned">Nobody's</option>
            {[...people].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <button type="submit" className={buttonQuiet}>Show</button>
        </form>
      )}

      <div className="mt-6">
        <Section title="My tasks" items={groups.mine} />
        <Section title="Nobody has these yet" hint="Take one, or start it and it becomes yours." items={groups.unassigned} />
        <Section title="With others" items={groups.others} />

        {orphans.length > 0 && (
          <section className="mt-8" aria-label="Rooms without a task">
            <h2 className="font-display text-xl">Rooms without a task <span className="text-base text-muted">({orphans.length})</span></h2>
            <p className="mt-1 max-w-prose text-sm text-muted">These rooms are marked dirty or being cleaned but have no cleaning task. Create one so the work shows up above.</p>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {orphans.map((r) => (
                <li key={r.id} className="rounded border border-line bg-white p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-lg font-semibold">{r.room_number}</span>
                    <span className="text-xs text-muted">{r.floor !== null ? `Floor ${r.floor}` : ""}{showProperty ? `${r.floor !== null ? ", " : ""}${propName.get(r.property_id) ?? ""}` : ""}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{r.housekeeping_status === "in_progress" ? "Being cleaned" : "Dirty"}</p>
                  <form action={createTask} className="mt-3">
                    <input type="hidden" name="roomId" value={r.id} />
                    <input type="hidden" name="taskType" value="cleaning" />
                    <input type="hidden" name="priority" value={activity.get(r.id)?.arrivesToday ? "high" : "normal"} />
                    <button type="submit" className={buttonQuiet}>Create cleaning task</button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        )}

        {done.length > 0 && (
          <section className="mt-8" aria-label="Done recently">
            <h2 className="font-display text-xl">Done in the last 24 hours <span className="text-base text-muted">({done.length})</span></h2>
            <ul className="mt-3 divide-y divide-line rounded border border-line bg-white text-sm">
              {done.map((t) => (
                <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                  <span><span className="font-semibold">{roomById.get(t.room_id)?.room_number ?? "Room"}</span> <span className="text-muted">{TASK_TYPE_LABEL[t.task_type] ?? t.task_type}</span>{t.completion_note ? <span className="text-muted">: {t.completion_note}</span> : null}</span>
                  <span className="text-xs text-muted">{new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz.get(t.property_id) ?? "UTC" }).format(new Date(t.completed_at ?? now))}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {createRooms.length > 0 && (
          <section className="mt-8" aria-label="Add a task">
            <h2 className="font-display text-xl">Add a task</h2>
            <form action={createTask} className="mt-3 grid max-w-2xl gap-3 rounded border border-line bg-white p-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-muted">Room</span>
                <select name="roomId" required className={inputClass} defaultValue="">
                  <option value="" disabled>Choose a room</option>
                  {createRooms.map((r) => (
                    <option key={r.id} value={r.id}>{r.room_number}{r.floor !== null ? `, floor ${r.floor}` : ""}{showProperty ? `, ${propName.get(r.property_id) ?? ""}` : ""}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted">Type</span>
                <select name="taskType" className={inputClass} defaultValue="deep_clean">
                  {TASK_TYPES.map((k) => <option key={k} value={k}>{TASK_TYPE_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted">Priority</span>
                <select name="priority" className={inputClass} defaultValue="normal">
                  {TASK_PRIORITIES.map((k) => <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>)}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted">Due (optional, hotel time)</span>
                <input name="due" type="datetime-local" className={inputClass} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted">Note (optional)</span>
                <input name="notes" maxLength={500} className={inputClass} />
              </label>
              <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Add task</button></div>
            </form>
            <p className="mt-2 max-w-prose text-xs text-muted">A room can have one open task of each type except Other. Adding a second one just shows the existing task.</p>
          </section>
        )}
      </div>
    </main>
  );
}
