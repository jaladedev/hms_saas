import { describe, expect, it } from "vitest";
import { buildRows, clip, dayHeads, nightTotals, parseWindow, shiftStart } from "./room-calendar";
import type { BoardClaim, BoardRoom } from "./room-board";

const room = (id: string, num: string, over: Partial<BoardRoom> = {}): BoardRoom => ({
  id,
  property_id: "p",
  room_type_id: "t",
  room_number: num,
  floor: 1,
  operational_status: "active",
  housekeeping_status: "clean",
  room_type_name: "Standard",
  ...over,
});
const claim = (id: string, room_id: string, start: string, end: string, over: Partial<BoardClaim> = {}): BoardClaim => ({
  id,
  room_id,
  claim_type: "stay",
  start_date: start,
  end_date: end,
  reservation_room_id: null,
  block_reason: null,
  ...over,
});
const W = parseWindow("2026-11-10", "7", "2026-11-10"); // nights 10th to 16th, end 17th

describe("parseWindow", () => {
  it("defaults to today and 14 days, and accepts only the offered lengths", () => {
    expect(parseWindow(undefined, undefined, "2026-11-04")).toEqual({ start: "2026-11-04", days: 14, end: "2026-11-18" });
    expect(parseWindow("2026-12-30", "30", "2026-11-04")).toEqual({ start: "2026-12-30", days: 30, end: "2027-01-29" });
    expect(parseWindow("nonsense", "9", "2026-11-04").days).toBe(14);
    expect(parseWindow("2026-02-30", "7", "2026-11-04").start).toBe("2026-11-04");
    expect(parseWindow(["a"], ["7"], "2026-11-04").start).toBe("2026-11-04");
  });
  it("moves a whole window at a time", () => {
    expect(shiftStart(W, 1)).toBe("2026-11-17");
    expect(shiftStart(W, -1)).toBe("2026-11-03");
  });
});

describe("dayHeads", () => {
  it("labels each night, marks today, weekends and the first day of a month", () => {
    const heads = dayHeads(parseWindow("2026-10-30", "7", "x"), "2026-11-01");
    expect(heads.map((h) => h.date)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
    ]);
    expect(heads[1]).toMatchObject({ weekday: "Sat", isWeekend: true, isToday: false });
    expect(heads[2]).toMatchObject({ weekday: "Sun", isToday: true, monthStart: true, month: "Nov", day: 1 });
    expect(heads[0]!.monthStart).toBe(true);
    expect(heads[3]!.monthStart).toBe(false);
  });
});

describe("clip", () => {
  it("covers the nights from arrival up to, not including, the departure day", () => {
    expect(clip(claim("a", "r", "2026-11-12", "2026-11-15"), W)).toEqual({
      column: 3,
      span: 3,
      continuesBefore: false,
      continuesAfter: false,
    });
  });
  it("cuts at both edges and says it carries on", () => {
    expect(clip(claim("a", "r", "2026-11-05", "2026-11-12"), W)).toEqual({
      column: 1,
      span: 2,
      continuesBefore: true,
      continuesAfter: false,
    });
    expect(clip(claim("a", "r", "2026-11-15", "2026-11-30"), W)).toEqual({
      column: 6,
      span: 2,
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(clip(claim("a", "r", "2026-11-01", "2026-12-01"), W)).toEqual({
      column: 1,
      span: 7,
      continuesBefore: true,
      continuesAfter: true,
    });
  });
  it("leaves out claims that only touch the edge: one leaving on the first day, one arriving on the day after the last", () => {
    expect(clip(claim("a", "r", "2026-11-08", "2026-11-10"), W)).toBeNull();
    expect(clip(claim("a", "r", "2026-11-17", "2026-11-19"), W)).toBeNull();
    expect(clip(claim("a", "r", "2026-11-16", "2026-11-18"), W)).toEqual({
      column: 7,
      span: 1,
      continuesBefore: false,
      continuesAfter: true,
    });
  });
  it("works across a month and a year end", () => {
    const w = parseWindow("2026-12-29", "7", "x");
    expect(clip(claim("a", "r", "2026-12-31", "2027-01-02"), w)).toEqual({
      column: 3,
      span: 2,
      continuesBefore: false,
      continuesAfter: false,
    });
  });
});

describe("buildRows", () => {
  const rooms = [
    room("r10", "10"),
    room("r2", "2"),
    room("rs", "1", { room_type_name: "Suite" }),
    room("rx", "9", { operational_status: "retired" }),
    room("ro", "3", { operational_status: "out_of_service" }),
  ];
  it("orders by room type then natural room number, and leaves retired rooms out", () => {
    expect(buildRows(rooms, [], W).map((r) => r.room.id)).toEqual(["r2", "ro", "r10", "rs"]);
  });
  it("gives each room its bars in date order and names the kind", () => {
    const rows = buildRows(
      rooms,
      [
        claim("b", "r2", "2026-11-14", "2026-11-16", { checked_in: false }),
        claim("a", "r2", "2026-11-10", "2026-11-13", { checked_in: true }),
        claim("h", "r10", "2026-11-11", "2026-11-12", { claim_type: "hold" }),
        claim("k", "rs", "2026-11-10", "2026-11-12", { claim_type: "block", block_reason: "Leak" }),
        claim("far", "r2", "2026-12-01", "2026-12-03"),
      ],
      W,
    );
    const r2 = rows.find((r) => r.room.id === "r2")!;
    expect(r2.bars.map((b) => [b.claim.id, b.kind, b.column, b.span])).toEqual([
      ["a", "occupied", 1, 3],
      ["b", "arriving", 5, 2],
    ]);
    expect(rows.find((r) => r.room.id === "r10")!.bars[0]!.kind).toBe("held");
    expect(rows.find((r) => r.room.id === "rs")!.bars[0]!.kind).toBe("blocked");
  });
});

describe("nightTotals", () => {
  it("counts rooms with a stay each night, and the rooms that could be sold", () => {
    const rooms = [room("a", "1"), room("b", "2"), room("c", "3", { operational_status: "out_of_service" })];
    const rows = buildRows(
      rooms,
      [
        claim("s1", "a", "2026-11-10", "2026-11-12"),
        claim("s2", "b", "2026-11-11", "2026-11-13", { checked_in: true }),
        claim("k", "b", "2026-11-14", "2026-11-15", { claim_type: "block", block_reason: "x" }),
        claim("h", "a", "2026-11-12", "2026-11-13", { claim_type: "hold" }),
      ],
      W,
    );
    const t = nightTotals(rows, W);
    expect(t.map((n) => n.stays)).toEqual([1, 2, 1, 0, 0, 0, 0]);
    expect(t.map((n) => n.sellable)).toEqual([2, 2, 2, 2, 1, 2, 2]);
    expect(t[0]!.date).toBe("2026-11-10");
  });
});
