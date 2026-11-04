import { describe, expect, it } from "vitest";
import { canDropOn, canMoveBar, lastMovedNight, moveEffective, moveSummary } from "./calendar-move";

const today = "2026-11-10";
const stay = { claim_type: "stay", end_date: "2026-11-14", reservation_room_id: "rr" };

describe("canMoveBar", () => {
  it("offers stays and holds of a visible booking that still have a night to go, to people who may assign rooms", () => {
    expect(canMoveBar(stay, today, true)).toBe(true);
    expect(canMoveBar({ ...stay, claim_type: "hold" }, today, true)).toBe(true);
    expect(canMoveBar({ ...stay, end_date: "2026-11-11" }, today, true)).toBe(true);
  });
  it("refuses without the permission, without a visible booking, for blocks and for stays that are over", () => {
    expect(canMoveBar(stay, today, false)).toBe(false);
    expect(canMoveBar({ ...stay, reservation_room_id: null }, today, true)).toBe(false);
    expect(canMoveBar({ ...stay, claim_type: "block" }, today, true)).toBe(false);
    expect(canMoveBar({ ...stay, end_date: today }, today, true)).toBe(false);
    expect(canMoveBar({ ...stay, end_date: "2026-11-01" }, today, true)).toBe(false);
  });
});

describe("canDropOn", () => {
  const source = { roomId: "a", roomTypeId: "t" };
  it("takes another in-service room of the same type", () => {
    expect(canDropOn(source, { id: "b", room_type_id: "t", operational_status: "active" })).toBe(true);
  });
  it("refuses the same room, another type, and rooms out of service or retired", () => {
    expect(canDropOn(source, { id: "a", room_type_id: "t", operational_status: "active" })).toBe(false);
    expect(canDropOn(source, { id: "b", room_type_id: "u", operational_status: "active" })).toBe(false);
    expect(canDropOn(source, { id: "b", room_type_id: "t", operational_status: "out_of_service" })).toBe(false);
    expect(canDropOn(source, { id: "b", room_type_id: "t", operational_status: "retired" })).toBe(false);
  });
});

describe("moveEffective", () => {
  it("moves from the dropped night when it is inside what is left of the stay", () => {
    expect(moveEffective("2026-11-08", "2026-11-14", today, "2026-11-12")).toBe("2026-11-12");
    expect(moveEffective("2026-11-08", "2026-11-14", today, "2026-11-10")).toBe("2026-11-10");
    expect(moveEffective("2026-11-08", "2026-11-14", today, "2026-11-13")).toBe("2026-11-13");
  });
  it("moves everything that is left when the drop is before today, before the stay, on departure or after", () => {
    expect(moveEffective("2026-11-08", "2026-11-14", today, "2026-11-09")).toBe("2026-11-10");
    expect(moveEffective("2026-11-12", "2026-11-14", today, "2026-11-11")).toBe("2026-11-12");
    expect(moveEffective("2026-11-08", "2026-11-14", today, "2026-11-14")).toBe("2026-11-10");
    expect(moveEffective("2026-11-08", "2026-11-14", today, "2026-12-01")).toBe("2026-11-10");
    expect(moveEffective("2026-11-12", "2026-11-14", today, null)).toBe("2026-11-12");
  });
  it("has no answer when no night is left", () => {
    expect(moveEffective("2026-11-06", "2026-11-10", today, null)).toBeNull();
    expect(moveEffective("2026-11-06", "2026-11-09", today, "2026-11-08")).toBeNull();
  });
});

describe("moveSummary", () => {
  const dateText = (iso: string) => iso.slice(5);
  const base = { label: "HMS-1001", from: "101", to: "104", start: "2026-11-12", end: "2026-11-14", dateText };
  it("says whole stay when the move starts with the stay, and counts the nights", () => {
    expect(moveSummary({ ...base, effective: "2026-11-12" })).toBe(
      "Move HMS-1001 from room 101 to room 104: the whole of this room's stay, 2 nights, leaving 11-14. Earlier nights stay where they are. If room 104 is taken for any of those nights, nothing changes.",
    );
  });
  it("names the date for a later start and says one night in the singular", () => {
    const s = moveSummary({ ...base, effective: "2026-11-13" });
    expect(s).toContain("the stay from 11-13, 1 night, leaving 11-14");
    expect(lastMovedNight("2026-11-14")).toBe("2026-11-13");
  });
});
