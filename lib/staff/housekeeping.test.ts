import { describe, expect, it } from "vitest";
import { buildWorklist, nextStatus } from "./housekeeping";
import type { BoardClaim, BoardRoom } from "./room-board";

const TODAY = new Map([["p1", "2026-11-03"]]);
const room = (n: string, over: Partial<BoardRoom> = {}): BoardRoom =>
  ({ id: n, property_id: "p1", room_type_id: "t", room_number: n, floor: Number(n[0]), operational_status: "active", housekeeping_status: "clean", ...over });
const claim = (room_id: string, start: string, end: string, over: Partial<BoardClaim> = {}): BoardClaim =>
  ({ id: `c-${room_id}-${start}`, room_id, claim_type: "stay", start_date: start, end_date: end, reservation_room_id: "rr", block_reason: null, ...over });
const nums = (l: { room: BoardRoom }[]) => l.map((i) => i.room.room_number);

describe("buildWorklist", () => {
  it("puts dirty rooms with an arrival today first, then other dirty rooms, then rooms being cleaned", () => {
    const w = buildWorklist(
      [room("101", { housekeeping_status: "dirty" }), room("102", { housekeeping_status: "dirty" }), room("103", { housekeeping_status: "in_progress" }), room("104")],
      [claim("102", "2026-11-03", "2026-11-05")], TODAY);
    expect(nums(w.urgent)).toEqual(["102"]);
    expect(nums(w.toClean)).toEqual(["101"]);
    expect(nums(w.inProgress)).toEqual(["103"]);
    expect(w.ready).toBe(1);
  });

  it("marks arrivals, departures, bookings tonight and blocks", () => {
    const w = buildWorklist([room("201", { housekeeping_status: "dirty" }), room("202", { housekeeping_status: "dirty" }), room("203", { housekeeping_status: "dirty" })], [
      claim("201", "2026-11-01", "2026-11-03"),
      claim("202", "2026-11-02", "2026-11-05"),
      claim("203", "2026-11-02", "2026-11-09", { claim_type: "block", reservation_room_id: null, block_reason: "paint" }),
    ], TODAY);
    const by = new Map([...w.urgent, ...w.toClean].map((i) => [i.room.room_number, i]));
    expect(by.get("201")).toMatchObject({ departsToday: true, arrivesToday: false, bookedTonight: false });
    expect(by.get("202")).toMatchObject({ bookedTonight: true, arrivesToday: false, departsToday: false });
    expect(by.get("203")).toMatchObject({ blockedToday: true, bookedTonight: false });
  });

  it("counts a hold arriving today as an arrival but not a block", () => {
    const w = buildWorklist([room("301", { housekeeping_status: "dirty" }), room("302", { housekeeping_status: "dirty" })], [
      claim("301", "2026-11-03", "2026-11-04", { claim_type: "hold" }),
      claim("302", "2026-11-03", "2026-11-04", { claim_type: "block", reservation_room_id: null, block_reason: "x" }),
    ], TODAY);
    expect(nums(w.urgent)).toEqual(["301"]);
    expect(nums(w.toClean)).toEqual(["302"]);
  });

  it("leaves out rooms that are out of service or retired", () => {
    const w = buildWorklist([room("401", { housekeeping_status: "dirty", operational_status: "out_of_service" }), room("402", { housekeeping_status: "dirty", operational_status: "retired" })], [], TODAY);
    expect(w.urgent.length + w.toClean.length).toBe(0);
    expect(w.skipped).toBe(2);
  });

  it("orders by floor, then room number naturally", () => {
    const w = buildWorklist(["210", "102", "21", "101"].map((n, i) => room(n, { housekeeping_status: "dirty", floor: n === "21" ? 2 : Number(n[0]) })), [], TODAY);
    expect(nums(w.toClean)).toEqual(["101", "102", "21", "210"]);
  });

  it("does not guess activity for a property whose date is unknown", () => {
    const w = buildWorklist([room("501", { property_id: "nope", housekeeping_status: "dirty" })], [claim("501", "2026-11-03", "2026-11-04")], TODAY);
    expect(nums(w.toClean)).toEqual(["501"]);
    expect(w.toClean[0]).toMatchObject({ arrivesToday: false, bookedTonight: false });
  });
});

describe("nextStatus", () => {
  it("moves dirty to in progress to clean, and has nothing for finished rooms", () => {
    expect(nextStatus("dirty")).toEqual({ to: "in_progress", label: "Start cleaning" });
    expect(nextStatus("in_progress")).toEqual({ to: "clean", label: "Mark clean" });
    expect(nextStatus("clean")).toBeNull();
    expect(nextStatus("inspected")).toBeNull();
  });
});
