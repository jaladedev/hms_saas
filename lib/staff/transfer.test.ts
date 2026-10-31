import { describe, expect, it } from "vitest";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";
import { addDays, candidateRooms, canTransfer, transferWindow, type CandidateRoom } from "./transfer";

describe("addDays", () => {
  it("does calendar arithmetic across month, year and leap boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });
});

describe("canTransfer", () => {
  it("needs room.assign, a live booking and a room that is neither out nor cancelled", () => {
    expect(canTransfer("booked", "confirmed", true)).toBe(true);
    expect(canTransfer("checked_in", "checked_in", true)).toBe(true);
    expect(canTransfer("booked", "pending", true)).toBe(true);
    expect(canTransfer("booked", "confirmed", false)).toBe(false);
    for (const rs of ["checked_out", "cancelled"]) expect(canTransfer(rs, "checked_in", true)).toBe(false);
    for (const st of ["cancelled", "expired", "no_show", "checked_out"]) expect(canTransfer("booked", st, true)).toBe(false);
  });
});

describe("transferWindow", () => {
  it("starts today for a stay under way and at arrival for one that has not begun", () => {
    expect(transferWindow("2026-10-29", "2026-11-03", "2026-10-31")).toEqual({ min: "2026-10-31", max: "2026-11-02", initial: "2026-10-31" });
    expect(transferWindow("2026-11-05", "2026-11-07", "2026-10-31")).toEqual({ min: "2026-11-05", max: "2026-11-06", initial: "2026-11-05" });
  });
  it("ends on the last night, and is null when none is left", () => {
    expect(transferWindow("2026-10-30", "2026-11-01", "2026-10-31")?.max).toBe("2026-10-31");
    expect(transferWindow("2026-10-30", "2026-10-31", "2026-10-31")).toBeNull();   // departs today
    expect(transferWindow("2026-10-28", "2026-10-30", "2026-10-31")).toBeNull();   // already past
  });
});

describe("candidateRooms", () => {
  const room = (id: string, n: string, type = "t1", st = "active"): CandidateRoom => ({ id, room_number: n, room_type_id: type, operational_status: st });
  const rooms = [room("a", "10"), room("b", "2"), room("c", "101A"), room("d", "3", "t2"), room("e", "4", "t1", "out_of_service"), room("f", "5", "t1", "retired")];
  it("offers same-type rooms in service, in natural order, never the current room", () => {
    const out = candidateRooms(rooms, "t1", new Set(["c"]), "2026-10-31", "2026-11-03", []);
    expect(out.map((r) => r.room_number)).toEqual(["2", "10"]);
  });
  it("marks a room as busy when any claim overlaps the nights (half-open ranges)", () => {
    const claims = [
      { room_id: "a", start_date: "2026-11-02", end_date: "2026-11-04" },   // overlaps
      { room_id: "b", start_date: "2026-11-03", end_date: "2026-11-05" },   // starts the day the stay ends: free
      { room_id: "c", start_date: "2026-10-28", end_date: "2026-10-31" },   // ends the day the move starts: free
    ];
    const out = candidateRooms(rooms, "t1", new Set(), "2026-10-31", "2026-11-03", claims);
    expect(Object.fromEntries(out.map((r) => [r.room_number, r.busy]))).toEqual({ "2": false, "10": true, "101A": false });
  });
});

describe("transfer errors", () => {
  it("maps the database's refusals to codes and plain sentences", () => {
    expect(classifyRpcError("POLICY_VIOLATION: effective date is in the past").code).toBe("transfer_past");
    expect(classifyRpcError("POLICY_VIOLATION: effective date is outside the stay").code).toBe("transfer_outside");
    expect(classifyRpcError("POLICY_VIOLATION: invalid target room").code).toBe("transfer_bad_room");
    expect(classifyRpcError("POLICY_VIOLATION: reason required").code).toBe("reason_required");
    expect(classifyRpcError("INVALID_STATE: checked_out").code).toBe("invalid_state");
    for (const c of ["transfer_unavailable", "transfer_past", "transfer_outside", "transfer_bad_room"]) {
      expect(errorMessage(c, null, String)).not.toMatch(/Something went wrong/);
    }
    expect(OK_MESSAGES.transferred).toMatch(/Room changed/);
  });
});
