/**
 * Housekeeping on tasks (migration 023): grouping, ordering and wording for the `/app/housekeeping` screen.
 * Pure functions, so they can be tested. The database decides who may do what; these helpers only decide what
 * to show and which buttons are worth offering.
 */
import type { ErrorCode } from "./refunds";
import { compareRoomNumbers, type BoardClaim, type BoardRoom } from "./room-board";

export const TASK_TYPES = ["cleaning", "deep_clean", "inspection", "other"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskRow = {
  id: string;
  property_id: string;
  room_id: string;
  task_type: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  due_at: string | null;
  notes: string | null;
  completion_note: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Only selected where history is shown (the room board). */
  cancel_reason?: string | null;
  cancelled_at?: string | null;
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  cleaning: "Cleaning", deep_clean: "Deep clean", inspection: "Inspection", other: "Other",
};
export const PRIORITY_LABEL: Record<string, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const isLive = (t: Pick<TaskRow, "status">) => t.status === "open" || t.status === "in_progress";

/** What a room is doing today, so a card can say "Guest arrives today". Needs only claims, never booking details. */
export type RoomActivity = { arrivesToday: boolean; departsToday: boolean; blockedToday: boolean };

export function activityByRoom(rooms: BoardRoom[], claims: BoardClaim[], today: Map<string, string>): Map<string, RoomActivity> {
  const byRoom = new Map<string, BoardClaim[]>();
  for (const c of claims) byRoom.set(c.room_id, [...(byRoom.get(c.room_id) ?? []), c]);
  const out = new Map<string, RoomActivity>();
  for (const room of rooms) {
    const t = today.get(room.property_id) ?? "";
    const mine = byRoom.get(room.id) ?? [];
    const stays = mine.filter((c) => c.claim_type === "stay" || c.claim_type === "hold");
    out.set(room.id, {
      arrivesToday: t !== "" && stays.some((c) => c.start_date === t),
      departsToday: t !== "" && stays.some((c) => c.end_date === t),
      blockedToday: t !== "" && mine.some((c) => c.claim_type === "block" && c.start_date <= t && c.end_date > t),
    });
  }
  return out;
}

/**
 * Most urgent first: priority, then the earliest due time (no due time goes last), then a guest arriving today,
 * then floor and room number. In-progress work is not pushed down; a started task is just as urgent as it was.
 */
export function sortTasks(tasks: TaskRow[], rooms: Map<string, BoardRoom>, activity: Map<string, RoomActivity>): TaskRow[] {
  const due = (t: TaskRow) => (t.due_at ? Date.parse(t.due_at) : Number.POSITIVE_INFINITY);
  const floor = (t: TaskRow) => rooms.get(t.room_id)?.floor ?? Number.MAX_SAFE_INTEGER;
  return [...tasks].sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    (due(a) === due(b) ? 0 : due(a) < due(b) ? -1 : 1) ||
    Number(activity.get(b.room_id)?.arrivesToday ?? false) - Number(activity.get(a.room_id)?.arrivesToday ?? false) ||
    floor(a) - floor(b) ||
    compareRoomNumbers(rooms.get(a.room_id)?.room_number ?? "", rooms.get(b.room_id)?.room_number ?? "") ||
    a.created_at.localeCompare(b.created_at));
}

export type TaskGroups = { mine: TaskRow[]; unassigned: TaskRow[]; others: TaskRow[] };

/** Live tasks split into the viewer's own, ones nobody has, and ones with someone else. Order within a group is kept. */
export function groupLive(tasks: TaskRow[], userId: string): TaskGroups {
  const g: TaskGroups = { mine: [], unassigned: [], others: [] };
  for (const t of tasks) {
    if (!isLive(t)) continue;
    if (t.assigned_to === userId) g.mine.push(t);
    else if (t.assigned_to === null) g.unassigned.push(t);
    else g.others.push(t);
  }
  return g;
}

export type TaskActions = { claim: boolean; start: boolean; complete: boolean; assign: boolean; cancel: boolean };

/**
 * Which buttons to offer for a task. This mirrors the database rules in 023 so people are not shown buttons that
 * will be refused; the database still decides.
 *  - work (housekeeping.update): claim an unassigned task, start or complete one's own, or an unassigned one
 *    (which takes it);
 *  - supervise (housekeeping.assign): start or complete anyone's, assign, unassign and cancel.
 */
export function actionsFor(task: TaskRow, userId: string, canWork: boolean, canAssign: boolean): TaskActions {
  const none: TaskActions = { claim: false, start: false, complete: false, assign: false, cancel: false };
  if (!isLive(task) || !canWork) return none;
  const mine = task.assigned_to === userId;
  const free = task.assigned_to === null;
  const mayWork = mine || free || canAssign;
  return {
    claim: free,
    start: task.status === "open" && mayWork,
    complete: mayWork,
    assign: canAssign,
    cancel: canAssign,
  };
}

/** Dirty or in-progress rooms with no live cleaning task (they predate migration 023); offered a "Create task" button. */
export function roomsWithoutTask(rooms: BoardRoom[], live: TaskRow[]): BoardRoom[] {
  const covered = new Set(live.filter((t) => t.task_type === "cleaning").map((t) => t.room_id));
  return rooms
    .filter((r) => r.operational_status === "active" && (r.housekeeping_status === "dirty" || r.housekeeping_status === "in_progress") && !covered.has(r.id))
    .sort((a, b) => (a.floor ?? Number.MAX_SAFE_INTEGER) - (b.floor ?? Number.MAX_SAFE_INTEGER) || compareRoomNumbers(a.room_number, b.room_number));
}

/** Tasks finished in the last `hours` hours, newest first, for the "Done recently" list. */
export function recentlyDone(tasks: TaskRow[], now: Date, hours = 24): TaskRow[] {
  const since = now.getTime() - hours * 3600_000;
  return tasks
    .filter((t) => t.status === "done" && t.completed_at !== null && Date.parse(t.completed_at) >= since)
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
}

/** "Due 14:30", or "Due 2 Nov, 09:00" when it is not today in the property's timezone; "Overdue" is added when past. */
export function formatDue(iso: string | null, timeZone: string, now: Date): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const parts = (tz: string) => {
    const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz });
    const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
    const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: tz });
    return { sameDay: day.format(due) === day.format(now), time: time.format(due), date: date.format(due) };
  };
  let p;
  try { p = parts(timeZone); } catch { p = parts("UTC"); }
  const overdue = due.getTime() < now.getTime();
  return { text: `${overdue ? "Overdue, was due" : "Due"} ${p.sameDay ? p.time : `${p.date}, ${p.time}`}`, overdue };
}

/**
 * Housekeeping-specific refusals. The shared classifier answers FORBIDDEN with the reservations sentence and would
 * word these wrongly, so the task actions look here first. Returns null when the shared classifier should decide.
 */
export function classifyTaskError(message: string): ErrorCode | null {
  if (/FORBIDDEN: assigned to someone else/.test(message)) return "task_taken";
  if (/^\s*FORBIDDEN|[\s:]FORBIDDEN\b/.test(message)) return "task_forbidden";
  if (/POLICY_VIOLATION: assignee/.test(message)) return "task_assignee";
  if (/POLICY_VIOLATION: reason/.test(message)) return "task_reason";
  if (/POLICY_VIOLATION: (task type|priority|notes too long|note too long)/.test(message)) return "task_invalid";
  return null;
}

/** Each room's most recent tasks, newest first, at most `perRoom` of them, for the history on a room card. */
export function historyByRoom(tasks: TaskRow[], perRoom = 5): Map<string, TaskRow[]> {
  const out = new Map<string, TaskRow[]>();
  for (const t of [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const list = out.get(t.room_id) ?? [];
    if (list.length < perRoom) out.set(t.room_id, [...list, t]);
  }
  return out;
}

/** "31 Oct, 15:05" in the property's timezone (UTC if it is unknown); empty for a missing or invalid time. */
export function formatShort(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(d);
  try { return fmt(timeZone); } catch { return fmt("UTC"); }
}

/** One line of a room's history: what the task was, where it stands, and when that happened. */
export function historyLine(t: TaskRow, timeZone: string): { title: string; detail: string } {
  const type = TASK_TYPE_LABEL[t.task_type] ?? t.task_type;
  const at = (iso: string | null | undefined) => formatShort(iso, timeZone);
  switch (t.status) {
    case "done": return { title: `${type}, done`, detail: [at(t.completed_at), t.completion_note].filter(Boolean).join(": ") };
    case "cancelled": return { title: `${type}, cancelled`, detail: [at(t.cancelled_at), t.cancel_reason].filter(Boolean).join(": ") };
    case "in_progress": return { title: `${type}, in progress`, detail: at(t.started_at ?? t.created_at) };
    default: return { title: `${type}, waiting`, detail: at(t.created_at) };
  }
}

/** Narrows live tasks to one person for a supervisor: "me", "unassigned", a user id, or anything else for everyone. */
export function filterByPerson(tasks: TaskRow[], who: string, userId: string): TaskRow[] {
  if (who === "me") return tasks.filter((t) => t.assigned_to === userId);
  if (who === "unassigned") return tasks.filter((t) => t.assigned_to === null);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who)) return tasks.filter((t) => t.assigned_to === who);
  return tasks;
}

/**
 * Turns a `datetime-local` value ("2026-11-03T14:30", hotel wall-clock time) into a UTC ISO string for the
 * property's timezone, or null for a malformed or impossible time. An unknown timezone is treated as UTC.
 */
export function zonedToIso(local: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  const offsetAt = (t: number): number => {
    try {
      const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - t;
    } catch {
      return 0;
    }
  };
  const t = wall - offsetAt(wall - offsetAt(wall));
  return new Date(t).toISOString();
}
