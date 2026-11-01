/**
 * Maintenance requests (migration 026): grouping, ordering and wording for `/app/maintenance`, its detail page and
 * the room board. Pure functions, so they can be tested. The database decides who may do what; these helpers only
 * decide what to show and which buttons are worth offering.
 */
import { formatShort, PRIORITY_LABEL, TASK_PRIORITIES } from "./housekeeping-tasks";
import type { ErrorCode } from "./refunds";
import { compareRoomNumbers } from "./room-board";

export { formatDue, formatShort, PRIORITY_LABEL, zonedToIso } from "./housekeeping-tasks";

export const REQUEST_PRIORITIES = TASK_PRIORITIES;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export type RequestRow = {
  id: string;
  property_id: string;
  room_id: string | null;
  location: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  assigned_to: string | null;
  due_at: string | null;
  room_block_id: string | null;
  reported_by: string | null;
  created_at: string;
  started_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
};

/** Every column the screens read; a request holds a place and some words, never a guest or a price. */
export const REQUEST_COLUMNS =
  "id, property_id, room_id, location, title, description, priority, status, assigned_to, due_at, room_block_id, reported_by, created_at, started_at, resolved_at, resolution_note, cancelled_at, cancel_reason";

export const STATUS_LABEL: Record<string, string> = { open: "Waiting", in_progress: "In progress", resolved: "Resolved", cancelled: "Cancelled" };
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const isLive = (r: Pick<RequestRow, "status">) => r.status === "open" || r.status === "in_progress";

/** "Room 204", or the place named for a fault outside the rooms ("Lobby"). */
export function placeOf(r: Pick<RequestRow, "room_id" | "location">, rooms: Map<string, { room_number: string }>): string {
  if (r.room_id) {
    const room = rooms.get(r.room_id);
    return room ? `Room ${room.room_number}` : "A room";
  }
  return r.location ?? "No place given";
}

/** A live request whose due time has passed. */
export function isOverdue(r: Pick<RequestRow, "status" | "due_at">, now: Date): boolean {
  if (!isLive(r) || !r.due_at) return false;
  const due = Date.parse(r.due_at);
  return !Number.isNaN(due) && due < now.getTime();
}

/**
 * Most urgent first: priority, then the earliest due time (no due time goes last), then the one waiting longest,
 * then room number. A request already started is not pushed down; it is just as urgent as it was.
 */
export function sortRequests(requests: RequestRow[], rooms: Map<string, { room_number: string }>): RequestRow[] {
  const due = (r: RequestRow) => (r.due_at ? Date.parse(r.due_at) : Number.POSITIVE_INFINITY);
  const number = (r: RequestRow) => (r.room_id ? rooms.get(r.room_id)?.room_number ?? "" : "\uffff");
  return [...requests].sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    (due(a) === due(b) ? 0 : due(a) < due(b) ? -1 : 1) ||
    a.created_at.localeCompare(b.created_at) ||
    compareRoomNumbers(number(a), number(b)));
}

export type RequestGroups = { mine: RequestRow[]; unassigned: RequestRow[]; others: RequestRow[] };

/** Live requests split into the viewer's own, ones nobody has, and ones with someone else. Order within a group is kept. */
export function groupLive(requests: RequestRow[], userId: string): RequestGroups {
  const g: RequestGroups = { mine: [], unassigned: [], others: [] };
  for (const r of requests) {
    if (!isLive(r)) continue;
    if (r.assigned_to === userId) g.mine.push(r);
    else if (r.assigned_to === null) g.unassigned.push(r);
    else g.others.push(r);
  }
  return g;
}

export type DashboardCounts = { open: number; highPriority: number; overdue: number; mine: number };

/** The only columns the counts read, so the overview and the sidebar can fetch a thin row instead of every column. */
export type RequestBrief = Pick<RequestRow, "status" | "priority" | "assigned_to" | "due_at">;

/** The figures at the top of the dashboard: how many are live, how many are high or urgent, overdue, and the viewer's. */
export function countRequests(requests: RequestBrief[], userId: string, now: Date): DashboardCounts {
  const live = requests.filter(isLive);
  return {
    open: live.length,
    highPriority: live.filter((r) => r.priority === "high" || r.priority === "urgent").length,
    overdue: live.filter((r) => isOverdue(r, now)).length,
    mine: live.filter((r) => r.assigned_to === userId).length,
  };
}

/** Narrows live requests to one person: "me", "unassigned", a user id, or anything else for everyone. */
export function filterByPerson(requests: RequestRow[], who: string, userId: string): RequestRow[] {
  if (who === "me") return requests.filter((r) => r.assigned_to === userId);
  if (who === "unassigned") return requests.filter((r) => r.assigned_to === null);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who)) return requests.filter((r) => r.assigned_to === who);
  return requests;
}

export type RequestActions = { claim: boolean; start: boolean; resolve: boolean; assign: boolean; cancel: boolean; priority: boolean; linkBlock: boolean };

/**
 * Which buttons to offer for a request. This mirrors the database rules in 026 so people are not shown buttons that
 * will be refused; the database still decides. Everything beyond reporting needs `maintenance.manage`. Anyone who
 * manages maintenance may start, resolve, assign, cancel, re-prioritise or link a block on any live request; only
 * taking one for yourself is limited to a request nobody has.
 */
export function actionsFor(r: Pick<RequestRow, "status" | "assigned_to" | "room_id">, canManage: boolean): RequestActions {
  const none: RequestActions = { claim: false, start: false, resolve: false, assign: false, cancel: false, priority: false, linkBlock: false };
  if (!isLive(r) || !canManage) return none;
  return {
    claim: r.assigned_to === null,
    start: r.status === "open",
    resolve: true,
    assign: true,
    cancel: true,
    priority: true,
    linkBlock: r.room_id !== null,
  };
}

/** Requests finished in the last `days` days, newest first, for the "Resolved lately" list. */
export function recentlyResolved(requests: RequestRow[], now: Date, days = 7): RequestRow[] {
  const since = now.getTime() - days * 86_400_000;
  return requests
    .filter((r) => r.status === "resolved" && r.resolved_at !== null && Date.parse(r.resolved_at) >= since)
    .sort((a, b) => (b.resolved_at ?? "").localeCompare(a.resolved_at ?? ""));
}

export type RoomFault = { count: number; top: string };

/** Per room: how many live requests it has and the highest priority among them, for the room card's indicator. */
export function faultsByRoom(requests: RequestRow[]): Map<string, RoomFault> {
  const out = new Map<string, RoomFault>();
  for (const r of requests) {
    if (!isLive(r) || !r.room_id) continue;
    const cur = out.get(r.room_id);
    if (!cur) out.set(r.room_id, { count: 1, top: r.priority });
    else out.set(r.room_id, { count: cur.count + 1, top: (PRIORITY_RANK[r.priority] ?? 9) < (PRIORITY_RANK[cur.top] ?? 9) ? r.priority : cur.top });
  }
  return out;
}

/** "1 repair", "3 repairs"; with the top priority named when it is high or urgent: "2 repairs, urgent". */
export function faultLabel(f: RoomFault): string {
  const base = `${f.count} ${f.count === 1 ? "repair" : "repairs"}`;
  return f.top === "urgent" || f.top === "high" ? `${base}, ${PRIORITY_LABEL[f.top]?.toLowerCase()}` : base;
}

/** Each room's most recent requests, newest first, at most `perRoom` of them, for the history on a room card. */
export function historyByRoom(requests: RequestRow[], perRoom = 5): Map<string, RequestRow[]> {
  const out = new Map<string, RequestRow[]>();
  for (const r of [...requests].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (!r.room_id) continue;
    const list = out.get(r.room_id) ?? [];
    if (list.length < perRoom) out.set(r.room_id, [...list, r]);
  }
  return out;
}

/** One line of a room's repair history: what it was, where it stands, and when that happened. */
export function historyLine(r: RequestRow, timeZone: string): { title: string; detail: string } {
  const when = (iso: string | null | undefined) => formatShort(iso, timeZone);
  switch (r.status) {
    case "resolved": return { title: `${r.title}, resolved`, detail: [when(r.resolved_at), r.resolution_note].filter(Boolean).join(": ") };
    case "cancelled": return { title: `${r.title}, cancelled`, detail: [when(r.cancelled_at), r.cancel_reason].filter(Boolean).join(": ") };
    case "in_progress": return { title: `${r.title}, in progress`, detail: when(r.started_at ?? r.created_at) };
    default: return { title: `${r.title}, waiting`, detail: when(r.created_at) };
  }
}

export type BlockChoice = { id: string; label: string };
type ClaimLike = { id: string; room_id: string; claim_type: string; start_date: string; end_date: string; block_reason: string | null };

/**
 * The room blocks a request may point at: this room's blocks that have not ended yet, plus the one already linked
 * (even if it has ended or been released, so the screen can show it). Soonest first.
 */
export function blocksForRequest<C extends ClaimLike>(r: Pick<RequestRow, "room_id" | "room_block_id">, claims: C[], today: string, describe: (c: C) => string): BlockChoice[] {
  if (!r.room_id) return [];
  return claims
    .filter((c) => c.claim_type === "block" && c.room_id === r.room_id && (c.end_date > today || c.id === r.room_block_id))
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .map((c) => ({ id: c.id, label: describe(c) }));
}

/**
 * Maintenance-specific refusals. The shared classifier answers FORBIDDEN with the reservations sentence and would
 * word these wrongly, so the maintenance actions look here first. Returns null when the shared classifier decides.
 */
export function classifyMaintenanceError(message: string): ErrorCode | null {
  if (/FORBIDDEN: assigned to someone else/.test(message)) return "mt_taken";
  if (/^\s*FORBIDDEN|[\s:]FORBIDDEN\b/.test(message)) return "mt_forbidden";
  if (/POLICY_VIOLATION: assignee/.test(message)) return "mt_assignee";
  if (/POLICY_VIOLATION: reason/.test(message)) return "mt_reason";
  if (/POLICY_VIOLATION: a room or a place/.test(message)) return "mt_place";
  if (/POLICY_VIOLATION: (block|a request with no room)/.test(message)) return "mt_block";
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "mt_duplicate";
  if (/POLICY_VIOLATION: (title|description too long|location too long|priority|note too long|room)/.test(message)) return "mt_invalid";
  return null;
}
