import { describe, expect, it } from "vitest";
import { canChangeType, otherTypes, typeChangeError, typeChangeWindow } from "./room-type-change";

describe("canChangeType", () => {
  it("offers it to a person who may assign rooms, for a confirmed booking or a guest in the house", () => {
    expect(canChangeType("booked", "confirmed", true, false)).toBe(true);
    expect(canChangeType("checked_in", "checked_in", true, false)).toBe(true);
  });
  it("does not offer it without the permission, with a discount, for a held, cancelled or finished booking or room", () => {
    expect(canChangeType("booked", "confirmed", false, false)).toBe(false);
    expect(canChangeType("booked", "confirmed", true, true)).toBe(false);
    expect(canChangeType("booked", "pending", true, false)).toBe(false);
    expect(canChangeType("cancelled", "cancelled", true, false)).toBe(false);
    expect(canChangeType("checked_out", "checked_in", true, false)).toBe(false);
  });
});

describe("typeChangeWindow", () => {
  it("runs from the arrival (or today once the stay has begun) to the last night", () => {
    expect(typeChangeWindow("2026-12-01", "2026-12-05", "2026-11-10")).toEqual({ min: "2026-12-01", max: "2026-12-04", initial: "2026-12-01" });
    expect(typeChangeWindow("2026-11-08", "2026-11-12", "2026-11-10")).toEqual({ min: "2026-11-10", max: "2026-11-11", initial: "2026-11-10" });
    expect(typeChangeWindow("2026-11-08", "2026-11-10", "2026-11-10")).toBeNull();
  });
});

describe("otherTypes", () => {
  it("lists active types other than the current one, by name", () => {
    const types = [{ id: "a", name: "Suite", status: "active" }, { id: "b", name: "Standard", status: "active" }, { id: "c", name: "Old", status: "inactive" }, { id: "d", name: "Deluxe", status: "active" }];
    expect(otherTypes(types, "b").map((t) => t.id)).toEqual(["d", "a"]);
  });
});

describe("typeChangeError", () => {
  it("knows the refusals of change_room_type", () => {
    expect(typeChangeError("POLICY_VIOLATION: discount")).toBe("rt_discount");
    expect(typeChangeError("INVALID_STATE: payment started")).toBe("rt_busy");
    expect(typeChangeError("POLICY_VIOLATION: same room type")).toBe("rt_same");
    expect(typeChangeError("POLICY_VIOLATION: effective date")).toBe("rt_effective");
    expect(typeChangeError("ROOM_UNAVAILABLE")).toBeNull();
    expect(typeChangeError("POLICY_VIOLATION: effective date is in the past")).toBeNull();
  });
});
