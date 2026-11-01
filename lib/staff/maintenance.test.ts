import { describe, expect, it } from "vitest";
import {
  actionsFor, blocksForRequest, classifyMaintenanceError, countRequests, faultLabel, faultsByRoom, filterByPerson, groupLive, historyByRoom,
  historyLine, isOverdue, placeOf, recentlyResolved, sortRequests, type RequestRow,
} from "./maintenance";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";

const rooms = new Map([["101", { room_number: "101" }], ["102", { room_number: "102" }], ["201", { room_number: "201" }]]);
const req = (id: string, over: Partial<RequestRow> = {}): RequestRow => ({
  id, property_id: "p1", room_id: "101", location: null, title: `Fault ${id}`, description: null, priority: "normal", status: "open",
  assigned_to: null, due_at: null, room_block_id: null, reported_by: null, created_at: "2026-11-03T06:00:00Z", started_at: null,
  resolved_at: null, resolution_note: null, cancelled_at: null, cancel_reason: null, ...over,
});
const ids = (l: RequestRow[]) => l.map((r) => r.id);
const NOW = new Date("2026-11-03T12:00:00Z");

describe("placeOf", () => {
  it("names the room, or the place for a fault outside the rooms", () => {
    expect(placeOf(req("a"), rooms)).toBe("Room 101");
    expect(placeOf(req("b", { room_id: null, location: "Lobby" }), rooms)).toBe("Lobby");
  });
  it("copes with an unknown room and with no place at all", () => {
    expect(placeOf(req("c", { room_id: "gone" }), rooms)).toBe("A room");
    expect(placeOf(req("d", { room_id: null, location: null }), rooms)).toBe("No place given");
  });
});

describe("isOverdue", () => {
  it("is true only for a live request past its due time", () => {
    expect(isOverdue(req("a", { due_at: "2026-11-03T08:00:00Z" }), NOW)).toBe(true);
    expect(isOverdue(req("b", { due_at: "2026-11-03T18:00:00Z" }), NOW)).toBe(false);
    expect(isOverdue(req("c"), NOW)).toBe(false);
    expect(isOverdue(req("d", { due_at: "2026-11-03T08:00:00Z", status: "resolved" }), NOW)).toBe(false);
    expect(isOverdue(req("e", { due_at: "2026-11-03T08:00:00Z", status: "cancelled" }), NOW)).toBe(false);
    expect(isOverdue(req("f", { due_at: "not a date" }), NOW)).toBe(false);
  });
});

describe("sortRequests", () => {
  it("orders by priority, then due time with none last, then the one waiting longest", () => {
    const out = sortRequests([
      req("low", { priority: "low" }),
      req("late", { due_at: "2026-11-03T15:00:00Z" }),
      req("none-new", { created_at: "2026-11-03T09:00:00Z" }),
      req("none-old", { created_at: "2026-11-02T09:00:00Z" }),
      req("early", { due_at: "2026-11-03T10:00:00Z" }),
      req("urgent", { priority: "urgent" }),
      req("high", { priority: "high" }),
    ], rooms);
    expect(ids(out)).toEqual(["urgent", "high", "early", "late", "none-old", "none-new", "low"]);
  });
  it("puts faults outside the rooms after rooms of the same age, and does not change its input", () => {
    const input = [req("lobby", { room_id: null, location: "Lobby" }), req("r201", { room_id: "201" }), req("r101", { room_id: "101" })];
    const copy = [...input];
    expect(ids(sortRequests(input, rooms))).toEqual(["r101", "r201", "lobby"]);
    expect(input).toEqual(copy);
  });
});

describe("groupLive and filterByPerson", () => {
  const all = [
    req("m", { assigned_to: "me" }), req("u"), req("o", { assigned_to: "6f1c2a3e-1111-4222-8333-444455556666", status: "in_progress", started_at: "x" }),
    req("d", { status: "resolved", assigned_to: "me", resolved_at: "x", started_at: "x" }), req("c", { status: "cancelled" }),
  ];
  it("splits live requests into mine, unassigned and others, and drops finished ones", () => {
    const g = groupLive(all, "me");
    expect(ids(g.mine)).toEqual(["m"]);
    expect(ids(g.unassigned)).toEqual(["u"]);
    expect(ids(g.others)).toEqual(["o"]);
  });
  it("filters to mine, unassigned or one person, and shows everything otherwise", () => {
    expect(ids(filterByPerson(all, "me", "me"))).toEqual(["m", "d"]);
    expect(ids(filterByPerson(all, "unassigned", "me"))).toEqual(["u", "c"]);
    expect(ids(filterByPerson(all, "6f1c2a3e-1111-4222-8333-444455556666", "me"))).toEqual(["o"]);
    expect(ids(filterByPerson(all, "", "me"))).toEqual(ids(all));
    expect(ids(filterByPerson(all, "' or 1=1", "me"))).toEqual(ids(all));
  });
});

describe("countRequests", () => {
  it("counts live, high or urgent, overdue and the viewer's own, ignoring finished ones", () => {
    const c = countRequests([
      req("a", { priority: "urgent", assigned_to: "me", due_at: "2026-11-03T08:00:00Z" }),
      req("b", { priority: "high" }),
      req("c", { assigned_to: "me" }),
      req("d", { priority: "urgent", status: "resolved", resolved_at: "x", started_at: "x" }),
      req("e", { priority: "high", status: "cancelled" }),
    ], "me", NOW);
    expect(c).toEqual({ open: 3, highPriority: 2, overdue: 1, mine: 2 });
  });
  it("is all zeros with nothing to count", () => expect(countRequests([], "me", NOW)).toEqual({ open: 0, highPriority: 0, overdue: 0, mine: 0 }));
});

describe("actionsFor (mirrors the database rules in 026)", () => {
  it("offers nothing without maintenance.manage, or on a finished request", () => {
    const none = { claim: false, start: false, resolve: false, assign: false, cancel: false, priority: false, linkBlock: false };
    expect(actionsFor(req("a"), false)).toEqual(none);
    expect(actionsFor(req("b", { status: "resolved" }), true)).toEqual(none);
    expect(actionsFor(req("c", { status: "cancelled" }), true)).toEqual(none);
  });
  it("lets a manager take only a request nobody has, but start, resolve, assign, cancel and re-prioritise any live one", () => {
    expect(actionsFor(req("a"), true)).toEqual({ claim: true, start: true, resolve: true, assign: true, cancel: true, priority: true, linkBlock: true });
    const taken = actionsFor(req("b", { assigned_to: "someone" }), true);
    expect(taken.claim).toBe(false);
    expect(taken.start && taken.resolve && taken.assign && taken.cancel && taken.priority).toBe(true);
  });
  it("offers no Start once started, and no block link for a fault outside the rooms", () => {
    expect(actionsFor(req("a", { status: "in_progress", started_at: "x" }), true).start).toBe(false);
    expect(actionsFor(req("b", { room_id: null, location: "Lobby" }), true).linkBlock).toBe(false);
  });
});

describe("recentlyResolved", () => {
  it("keeps only requests resolved in the last 7 days, newest first", () => {
    const out = recentlyResolved([
      req("old", { status: "resolved", resolved_at: "2026-10-26T11:59:00Z" }),
      req("a", { status: "resolved", resolved_at: "2026-11-01T08:00:00Z" }),
      req("b", { status: "resolved", resolved_at: "2026-11-03T10:00:00Z" }),
      req("open"), req("gone", { status: "cancelled", cancelled_at: "2026-11-03T10:00:00Z" }),
    ], NOW);
    expect(ids(out)).toEqual(["b", "a"]);
  });
});

describe("faultsByRoom and faultLabel", () => {
  it("counts live requests per room with the highest priority, ignoring finished ones and faults outside the rooms", () => {
    const f = faultsByRoom([
      req("a", { priority: "low" }), req("b", { priority: "urgent" }), req("c", { room_id: "102" }),
      req("d", { room_id: "102", status: "resolved", resolved_at: "x", started_at: "x" }), req("e", { room_id: null, location: "Lobby" }),
    ]);
    expect(f.get("101")).toEqual({ count: 2, top: "urgent" });
    expect(f.get("102")).toEqual({ count: 1, top: "normal" });
    expect(f.size).toBe(2);
  });
  it("words the count and names only a high or urgent priority", () => {
    expect(faultLabel({ count: 1, top: "normal" })).toBe("1 repair");
    expect(faultLabel({ count: 3, top: "low" })).toBe("3 repairs");
    expect(faultLabel({ count: 2, top: "high" })).toBe("2 repairs, high");
    expect(faultLabel({ count: 1, top: "urgent" })).toBe("1 repair, urgent");
  });
});

describe("historyByRoom and historyLine", () => {
  it("keeps each room's newest few and leaves out faults outside the rooms", () => {
    const h = historyByRoom([
      req("a", { created_at: "2026-11-01T08:00:00Z" }), req("b", { created_at: "2026-11-02T08:00:00Z" }), req("c", { created_at: "2026-11-03T08:00:00Z" }),
      req("d", { room_id: "102", created_at: "2026-11-01T08:00:00Z" }), req("lobby", { room_id: null, location: "Lobby" }),
    ], 2);
    expect(ids(h.get("101")!)).toEqual(["c", "b"]);
    expect(ids(h.get("102")!)).toEqual(["d"]);
    expect(h.size).toBe(2);
  });
  it("describes each status with a time in the property's timezone", () => {
    const tz = "Africa/Lagos";
    expect(historyLine(req("1", { title: "Tap", status: "resolved", resolved_at: "2026-11-03T13:05:00Z", resolution_note: "new washer", started_at: "x" }), tz))
      .toEqual({ title: "Tap, resolved", detail: "3 Nov, 14:05: new washer" });
    expect(historyLine(req("2", { title: "Tap", status: "cancelled", cancelled_at: "2026-11-03T07:00:00Z", cancel_reason: "duplicate" }), tz))
      .toEqual({ title: "Tap, cancelled", detail: "3 Nov, 08:00: duplicate" });
    expect(historyLine(req("3", { title: "Tap", status: "in_progress", started_at: "2026-11-03T06:30:00Z" }), tz))
      .toEqual({ title: "Tap, in progress", detail: "3 Nov, 07:30" });
    expect(historyLine(req("4", { title: "Tap" }), tz)).toEqual({ title: "Tap, waiting", detail: "3 Nov, 07:00" });
  });
});

describe("blocksForRequest", () => {
  const claim = (id: string, room_id: string, start: string, end: string, type = "block") =>
    ({ id, room_id, claim_type: type, start_date: start, end_date: end, block_reason: `r-${id}` });
  const describe_ = (c: { block_reason: string | null }) => c.block_reason ?? "";
  const today = "2026-11-03";

  it("offers this room's blocks that have not ended, soonest first, and nothing else", () => {
    const out = blocksForRequest(req("a"), [
      claim("late", "101", "2026-11-10", "2026-11-12"), claim("now", "101", "2026-11-01", "2026-11-05"), claim("ended", "101", "2026-10-01", "2026-11-03"),
      claim("other-room", "102", "2026-11-01", "2026-11-05"), claim("stay", "101", "2026-11-01", "2026-11-05", "stay"),
    ], today, describe_);
    expect(out).toEqual([{ id: "now", label: "r-now" }, { id: "late", label: "r-late" }]);
  });
  it("keeps the linked block in the list even after it has ended", () => {
    const out = blocksForRequest(req("a", { room_block_id: "ended" }), [claim("ended", "101", "2026-10-01", "2026-11-03")], today, describe_);
    expect(out.map((c) => c.id)).toEqual(["ended"]);
  });
  it("offers nothing for a fault outside the rooms", () => {
    expect(blocksForRequest(req("a", { room_id: null, location: "Lobby" }), [claim("x", "101", "2026-11-01", "2026-11-05")], today, describe_)).toEqual([]);
  });
});

describe("classifyMaintenanceError", () => {
  it("words maintenance refusals itself", () => {
    expect(classifyMaintenanceError("FORBIDDEN: assigned to someone else")).toBe("mt_taken");
    expect(classifyMaintenanceError("FORBIDDEN")).toBe("mt_forbidden");
    expect(classifyMaintenanceError("POLICY_VIOLATION: assignee")).toBe("mt_assignee");
    expect(classifyMaintenanceError("POLICY_VIOLATION: reason")).toBe("mt_reason");
    expect(classifyMaintenanceError("POLICY_VIOLATION: a room or a place is needed")).toBe("mt_place");
    expect(classifyMaintenanceError("POLICY_VIOLATION: block")).toBe("mt_block");
    expect(classifyMaintenanceError("POLICY_VIOLATION: a request with no room has no block")).toBe("mt_block");
    expect(classifyMaintenanceError("IDEMPOTENCY_MISMATCH")).toBe("mt_duplicate");
    for (const m of ["POLICY_VIOLATION: title", "POLICY_VIOLATION: description too long", "POLICY_VIOLATION: location too long", "POLICY_VIOLATION: priority", "POLICY_VIOLATION: note too long", "POLICY_VIOLATION: room"]) {
      expect(classifyMaintenanceError(m), m).toBe("mt_invalid");
    }
  });
  it("leaves everything else to the shared classifier", () => {
    expect(classifyMaintenanceError("NOT_FOUND")).toBeNull();
    expect(classifyMaintenanceError("INVALID_STATE: request resolved")).toBeNull();
    expect(classifyRpcError("INVALID_STATE: request resolved").code).toBe("invalid_state");
    expect(classifyRpcError("NOT_FOUND").code).toBe("not_found");
  });
  it("words every maintenance code and never echoes raw database text", () => {
    for (const c of ["mt_taken", "mt_forbidden", "mt_assignee", "mt_reason", "mt_place", "mt_block", "mt_invalid", "mt_duplicate"]) {
      const text = errorMessage(c, null, String);
      expect(text, c).not.toMatch(/Something went wrong/);
      expect(text, c).not.toMatch(/P0001|POLICY_VIOLATION|FORBIDDEN|INVALID_STATE/);
    }
    for (const c of ["mt_reported", "mt_claimed", "mt_started", "mt_resolved", "mt_resolved_block", "mt_assigned", "mt_unassigned", "mt_cancelled", "mt_priority", "mt_block_linked", "mt_block_unlinked"] as const) {
      expect(OK_MESSAGES[c], c).toBeTruthy();
    }
  });
  it("tells the person a still-active block is not removed by resolving", () => {
    expect(OK_MESSAGES.mt_resolved_block).toMatch(/still blocked/);
    expect(OK_MESSAGES.mt_resolved_block).toMatch(/Remove the block/);
    expect(OK_MESSAGES.mt_block_unlinked).toMatch(/block itself is unchanged/);
  });
});
