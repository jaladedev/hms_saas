import { describe, expect, it } from "vitest";
import { classifyRpcError, errorMessage } from "./refunds";
import { roomsPayload, validateNewReservation } from "./new-reservation";

const P = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const base = { propertyId: P, roomTypeId: T, arrival: "2026-11-05", departure: "2026-11-07", adults: "2", children: "1", source: "walk_in", guestName: "  Ade   Bello ", guestEmail: "", guestPhone: "" };
const bad = (over: Record<string, unknown>) => { const r = validateNewReservation({ ...base, ...over }); return r.ok ? "ok" : r.code; };

describe("validateNewReservation", () => {
  it("accepts a good form and cleans it", () => {
    const r = validateNewReservation({ ...base, guestEmail: " ADE@Example.com ", guestPhone: "+234 803 000 0000" });
    expect(r).toEqual({ ok: true, value: {
      propertyId: P, roomTypeId: T, arrival: "2026-11-05", departure: "2026-11-07", adults: 2, children: 1, source: "walk_in",
      guest: { name: "Ade Bello", email: "ade@example.com", phone: "+234 803 000 0000" },
    } });
  });
  it("treats email and phone as optional", () => {
    const r = validateNewReservation(base);
    expect(r.ok && r.value.guest).toEqual({ name: "Ade Bello", email: null, phone: null });
  });
  it("refuses bad ids, names, dates and numbers with a specific code", () => {
    expect(bad({ propertyId: "x" })).toBe("bad_request");
    expect(bad({ roomTypeId: "" })).toBe("bad_request");
    expect(bad({ guestName: "   " })).toBe("guest_name_required");
    expect(bad({ guestEmail: "not-an-email" })).toBe("guest_failed");
    expect(bad({ guestPhone: "abc" })).toBe("guest_failed");
    expect(bad({ arrival: "2026-02-30" })).toBe("dates_invalid");
    expect(bad({ departure: "2026-11-05" })).toBe("dates_invalid");
    expect(bad({ departure: "2026-11-04" })).toBe("dates_invalid");
    expect(bad({ departure: "2026-12-06" })).toBe("too_long_stay");
    expect(bad({ departure: "2026-12-05" })).toBe("ok");   // exactly 30 nights
    expect(bad({ adults: "0" })).toBe("capacity");
    expect(bad({ adults: "two" })).toBe("capacity");
    expect(bad({ children: "-1" })).toBe("capacity");
    expect(bad({ source: "website" })).toBe("bad_request");   // online bookings go through the guest site
  });
  it("defaults children to none", () => {
    const r = validateNewReservation({ ...base, children: undefined });
    expect(r.ok && r.value.children).toBe(0);
  });
});

describe("roomsPayload", () => {
  it("leaves the rate plan and room choice to the database", () => {
    const r = validateNewReservation(base);
    expect(r.ok && roomsPayload(r.value)).toEqual([{ room_type_id: T, requested_room_id: null, rate_plan_id: null, adults: 2, children: 1 }]);
  });
});

describe("create-reservation refusals", () => {
  it("are recognised and worded", () => {
    const cases: [string, string][] = [
      ["ROOM_UNAVAILABLE", "room_unavailable"], ["CAPACITY_EXCEEDED", "capacity"], ["RATE_MISSING: no rate plan", "rate_missing"],
      ["FORBIDDEN", "forbidden"], ["POLICY_VIOLATION: arrival in the past", "arrival_past"],
      ["POLICY_VIOLATION: departure must follow arrival", "dates_invalid"], ["NOT_FOUND: room type", "room_type_missing"],
    ];
    for (const [msg, code] of cases) {
      expect(classifyRpcError(msg).code, msg).toBe(code);
      expect(errorMessage(code, null, String), code).not.toMatch(/Nothing was changed|ROOM_|POLICY_/);
    }
  });
});
