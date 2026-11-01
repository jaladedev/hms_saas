import { describe, expect, it } from "vitest";
import {
  activityByRoom, actionsFor, classifyTaskError, formatDue, formatShort, groupLive, historyByRoom, historyLine, recentlyDone, roomsWithoutTask, sortTasks, type TaskRow,
} from "./housekeeping-tasks";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";
import type { BoardClaim, BoardRoom } from "./room-board";

const TODAY = new Map([["p1", "2026-11-03"]]);
const room = (n: string, over: Partial<BoardRoom> = {}): BoardRoom =>
  ({ id: n, property_id: "p1", room_type_id: "t", room_number: n, floor: Number(n[0]), operational_status: "active", housekeeping_status: "dirty", ...over });
const claim = (room_id: string, start: string, end: string, over: Partial<BoardClaim> = {}): BoardClaim =>
  ({ id: `c-${room_id}-${start}`, room_id, claim_type: "stay", start_date: start, end_date: end, reservation_room_id: "rr", block_reason: null, ...over });
const task = (id: string, room_id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id, property_id: "p1", room_id, task_type: "cleaning", status: "open", priority: "normal", assigned_to: null, due_at: null,
  notes: null, completion_note: null, created_at: "2026-11-03T06:00:00Z", started_at: null, completed_at: null, ...over,
});
const ids = (l: TaskRow[]) => l.map((t) => t.id);

describe("sortTasks", () => {
  const rooms = [room("101"), room("102"), room("201"), room("202")];
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const act = activityByRoom(rooms, [], TODAY);

  it("orders by priority, then due time with none last, then floor and room", () => {
    const out = sortTasks([
      task("low", "101", { priority: "low" }),
      task("normal-late", "102", { due_at: "2026-11-03T15:00:00Z" }),
      task("normal-none", "101"),
      task("normal-early", "201", { due_at: "2026-11-03T10:00:00Z" }),
      task("urgent", "202", { priority: "urgent" }),
      task("high", "102", { priority: "high" }),
    ], byId, act);
    expect(ids(out)).toEqual(["urgent", "high", "normal-early", "normal-late", "normal-none", "low"]);
  });

  it("puts a room with an arrival today ahead of an otherwise equal task", () => {
    const withArrival = activityByRoom(rooms, [claim("202", "2026-11-03", "2026-11-05")], TODAY);
    expect(ids(sortTasks([task("a", "101"), task("b", "202")], byId, withArrival))).toEqual(["b", "a"]);
  });

  it("orders rooms naturally and does not change its input", () => {
    const input = [task("t202", "202"), task("t102", "102"), task("t101", "101")];
    const copy = [...input];
    expect(ids(sortTasks(input, byId, act))).toEqual(["t101", "t102", "t202"]);
    expect(input).toEqual(copy);
  });
});

describe("activityByRoom", () => {
  it("marks arrivals, departures and blocks for today, and treats an unknown property as quiet", () => {
    const rooms = [room("101"), room("102"), room("103"), room("104", { property_id: "nope" })];
    const a = activityByRoom(rooms, [
      claim("101", "2026-11-03", "2026-11-05", { claim_type: "hold" }),
      claim("102", "2026-11-01", "2026-11-03"),
      claim("103", "2026-11-02", "2026-11-09", { claim_type: "block", reservation_room_id: null, block_reason: "paint" }),
      claim("104", "2026-11-03", "2026-11-04"),
    ], TODAY);
    expect(a.get("101")).toEqual({ arrivesToday: true, departsToday: false, blockedToday: false });
    expect(a.get("102")).toEqual({ arrivesToday: false, departsToday: true, blockedToday: false });
    expect(a.get("103")).toEqual({ arrivesToday: false, departsToday: false, blockedToday: true });
    expect(a.get("104")).toEqual({ arrivesToday: false, departsToday: false, blockedToday: false });
  });
});

describe("groupLive", () => {
  it("splits live tasks into mine, unassigned and others, and drops finished ones", () => {
    const g = groupLive([
      task("m", "1", { assigned_to: "me" }),
      task("u", "2"),
      task("o", "3", { assigned_to: "you", status: "in_progress", started_at: "x" }),
      task("d", "4", { status: "done", assigned_to: "me" }),
      task("c", "5", { status: "cancelled" }),
    ], "me");
    expect(ids(g.mine)).toEqual(["m"]);
    expect(ids(g.unassigned)).toEqual(["u"]);
    expect(ids(g.others)).toEqual(["o"]);
  });
});

describe("actionsFor (mirrors the database rules in 023)", () => {
  const free = task("t", "1");
  it("offers nothing without housekeeping.update, or for a finished task", () => {
    expect(Object.values(actionsFor(free, "me", false, false)).some(Boolean)).toBe(false);
    expect(Object.values(actionsFor(task("t", "1", { status: "done" }), "me", true, true)).some(Boolean)).toBe(false);
    expect(Object.values(actionsFor(task("t", "1", { status: "cancelled" }), "me", true, true)).some(Boolean)).toBe(false);
  });
  it("lets a cleaner take, start and finish an unassigned task, but not assign or cancel", () => {
    expect(actionsFor(free, "me", true, false)).toEqual({ claim: true, start: true, complete: true, assign: false, cancel: false });
  });
  it("lets a cleaner start and finish their own task, and offers no claim", () => {
    expect(actionsFor(task("t", "1", { assigned_to: "me" }), "me", true, false)).toEqual({ claim: false, start: true, complete: true, assign: false, cancel: false });
  });
  it("hides start once started, but keeps finish", () => {
    expect(actionsFor(task("t", "1", { assigned_to: "me", status: "in_progress", started_at: "x" }), "me", true, false))
      .toEqual({ claim: false, start: false, complete: true, assign: false, cancel: false });
  });
  it("gives a cleaner nothing on someone else's task", () => {
    expect(Object.values(actionsFor(task("t", "1", { assigned_to: "you" }), "me", true, false)).some(Boolean)).toBe(false);
  });
  it("gives a supervisor everything except claim on someone else's task", () => {
    expect(actionsFor(task("t", "1", { assigned_to: "you" }), "boss", true, true)).toEqual({ claim: false, start: true, complete: true, assign: true, cancel: true });
  });
});

describe("roomsWithoutTask", () => {
  it("lists dirty and in-progress active rooms that have no live cleaning task, in room order", () => {
    const rooms = [
      room("201"), room("102"), room("101", { housekeeping_status: "in_progress" }), room("103", { housekeeping_status: "clean" }),
      room("104", { operational_status: "out_of_service" }), room("105", { operational_status: "retired" }),
    ];
    const out = roomsWithoutTask(rooms, [task("t", "102"), task("i", "201", { task_type: "inspection" })]);
    expect(out.map((r) => r.room_number)).toEqual(["101", "201"]);
  });
});

describe("recentlyDone", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  it("keeps tasks finished within 24 hours, newest first", () => {
    const out = recentlyDone([
      task("old", "1", { status: "done", completed_at: "2026-11-02T11:59:00Z" }),
      task("a", "2", { status: "done", completed_at: "2026-11-03T08:00:00Z" }),
      task("b", "3", { status: "done", completed_at: "2026-11-03T10:00:00Z" }),
      task("open", "4"),
    ], now);
    expect(ids(out)).toEqual(["b", "a"]);
  });
});

describe("formatDue", () => {
  const now = new Date("2026-11-03T08:00:00Z");
  it("returns null with no due time", () => expect(formatDue(null, "Africa/Lagos", now)).toBeNull());
  it("shows just the time for today in the property's timezone", () => {
    expect(formatDue("2026-11-03T13:30:00Z", "Africa/Lagos", now)).toEqual({ text: "Due 14:30", overdue: false });
  });
  it("adds the date for another day", () => {
    expect(formatDue("2026-11-05T09:00:00Z", "Africa/Lagos", now)).toEqual({ text: "Due 5 Nov, 10:00", overdue: false });
  });
  it("flags a past time as overdue", () => {
    expect(formatDue("2026-11-03T06:00:00Z", "Africa/Lagos", now)).toEqual({ text: "Overdue, was due 07:00", overdue: true });
  });
  it("falls back to UTC for an unknown timezone and ignores garbage", () => {
    expect(formatDue("2026-11-03T13:30:00Z", "Nowhere/Land", now)?.text).toBe("Due 13:30");
    expect(formatDue("not a date", "Africa/Lagos", now)).toBeNull();
  });
});

describe("classifyTaskError", () => {
  it("words housekeeping refusals itself", () => {
    expect(classifyTaskError("FORBIDDEN: assigned to someone else")).toBe("task_taken");
    expect(classifyTaskError("FORBIDDEN")).toBe("task_forbidden");
    expect(classifyTaskError("POLICY_VIOLATION: assignee")).toBe("task_assignee");
    expect(classifyTaskError("POLICY_VIOLATION: reason")).toBe("task_reason");
    for (const m of ["POLICY_VIOLATION: task type", "POLICY_VIOLATION: priority", "POLICY_VIOLATION: notes too long", "POLICY_VIOLATION: note too long"]) {
      expect(classifyTaskError(m), m).toBe("task_invalid");
    }
  });
  it("leaves everything else to the shared classifier", () => {
    expect(classifyTaskError("NOT_FOUND")).toBeNull();
    expect(classifyTaskError("INVALID_STATE: task done")).toBeNull();
    expect(classifyRpcError("INVALID_STATE: task done").code).toBe("invalid_state");
    expect(classifyRpcError("NOT_FOUND").code).toBe("not_found");
    expect(classifyRpcError("INVALID_STATE: room retired").code).toBe("room_retired");
  });
  it("has a plain sentence for every task code and success code", () => {
    for (const c of ["task_taken", "task_forbidden", "task_assignee", "task_reason", "task_invalid"]) {
      expect(errorMessage(c, null, String), c).not.toMatch(/Something went wrong|POLICY_|FORBIDDEN/);
    }
    for (const c of ["task_created", "task_claimed", "task_started", "task_completed", "task_assigned", "task_unassigned", "task_cancelled"] as const) {
      expect(OK_MESSAGES[c], c).toBeTruthy();
    }
  });
});

describe("room history", () => {
  const mk = (id: string, room: string, created: string, over: Partial<TaskRow> = {}) => task(id, room, { created_at: created, ...over });

  it("keeps each room's newest tasks, newest first, and caps them", () => {
    const h = historyByRoom([
      mk("a", "101", "2026-11-01T08:00:00Z"), mk("b", "101", "2026-11-03T08:00:00Z"), mk("c", "101", "2026-11-02T08:00:00Z"),
      mk("d", "102", "2026-11-01T08:00:00Z"),
    ], 2);
    expect(ids(h.get("101")!)).toEqual(["b", "c"]);
    expect(ids(h.get("102")!)).toEqual(["d"]);
    expect(h.has("103")).toBe(false);
  });

  it("describes each status with a time in the property's timezone", () => {
    const tz = "Africa/Lagos";
    expect(historyLine(mk("1", "1", "2026-11-03T06:00:00Z", { status: "done", completed_at: "2026-11-03T13:05:00Z", completion_note: "spare towels", started_at: "x" }), tz))
      .toEqual({ title: "Cleaning, done", detail: "3 Nov, 14:05: spare towels" });
    expect(historyLine(mk("2", "1", "2026-11-03T06:00:00Z", { status: "cancelled", cancelled_at: "2026-11-03T07:00:00Z", cancel_reason: "room retired", task_type: "inspection" }), tz))
      .toEqual({ title: "Inspection, cancelled", detail: "3 Nov, 08:00: room retired" });
    expect(historyLine(mk("3", "1", "2026-11-03T06:00:00Z", { status: "in_progress", started_at: "2026-11-03T06:30:00Z" }), tz))
      .toEqual({ title: "Cleaning, in progress", detail: "3 Nov, 07:30" });
    expect(historyLine(mk("4", "1", "2026-11-03T06:00:00Z", { task_type: "deep_clean" }), tz))
      .toEqual({ title: "Deep clean, waiting", detail: "3 Nov, 07:00" });
  });

  it("copes with missing times and an unknown timezone", () => {
    expect(historyLine(mk("5", "1", "2026-11-03T06:00:00Z", { status: "done", completed_at: null }), "Africa/Lagos").detail).toBe("");
    expect(formatShort("2026-11-03T13:05:00Z", "Nowhere/Land")).toBe("3 Nov, 13:05");
    expect(formatShort("nope", "Africa/Lagos")).toBe("");
    expect(formatShort(null, "Africa/Lagos")).toBe("");
  });
});
