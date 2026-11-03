import { describe, expect, it } from "vitest";
import { classifyRpcError, errorMessage } from "./refunds";
import { MAX_ROOMS, roomsPayload, validateNewReservation } from "./new-reservation";

const P = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const base = { propertyId: P, roomTypeId: T, arrival: "2026-11-05", departure: "2026-11-07", adults: "2", children: "1", source: "walk_in", guestName: "  Ade   Bello ", guestEmail: "", guestPhone: "" };
const bad = (over: Record<string, unknown>) => { const r = validateNewReservation({ ...base, ...over }); return r.ok ? "ok" : r.code; };

describe("validateNewReservation", () => {
  it("accepts a good form and cleans it", () => {
    const r = validateNewReservation({ ...base, guestEmail: " ADE@Example.com ", guestPhone: "+234 803 000 0000" });
    expect(r).toEqual({ ok: true, value: {
      propertyId: P, rooms: [{ roomTypeId: T, requestedRoomId: null, adults: 2, children: 1 }], arrival: "2026-11-05", departure: "2026-11-07", source: "walk_in",
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
    expect(r.ok && r.value.rooms[0]?.children).toBe(0);
  });
});

describe("several rooms", () => {
  const T2 = "33333333-3333-4333-8333-333333333333";
  it("reads rooms 2 to 5 from the suffixed fields and skips empty slots", () => {
    const r = validateNewReservation({ ...base, roomTypeId_2: T2, adults_2: "1", roomTypeId_3: "", adults_3: "5", roomTypeId_4: T, adults_4: "3", children_4: "2" });
    expect(r.ok && r.value.rooms).toEqual([
      { roomTypeId: T, requestedRoomId: null, adults: 2, children: 1 }, { roomTypeId: T2, requestedRoomId: null, adults: 1, children: 0 }, { roomTypeId: T, requestedRoomId: null, adults: 3, children: 2 },
    ]);
  });
  it("defaults a later room to one adult and no children", () => {
    const r = validateNewReservation({ ...base, roomTypeId_2: T2 });
    expect(r.ok && r.value.rooms[1]).toEqual({ roomTypeId: T2, requestedRoomId: null, adults: 1, children: 0 });
  });
  it("refuses a bad later room with a specific code", () => {
    expect(bad({ roomTypeId_2: "nope" })).toBe("room_type_missing");
    expect(bad({ roomTypeId_2: T2, adults_2: "0" })).toBe("capacity");
    expect(bad({ roomTypeId_2: T2, children_2: "x" })).toBe("capacity");
  });
  it("allows up to the maximum and builds one payload entry per room", () => {
    const five = Object.fromEntries([2, 3, 4, 5].map((i) => [`roomTypeId_${i}`, T2]));
    const r = validateNewReservation({ ...base, ...five });
    expect(r.ok && r.value.rooms).toHaveLength(MAX_ROOMS);
    expect(r.ok && roomsPayload(r.value).map((x) => x.room_type_id)).toEqual([T, T2, T2, T2, T2]);
  });
  it("ignores a sixth room slot", () => {
    const r = validateNewReservation({ ...base, roomTypeId_6: T2 });
    expect(r.ok && r.value.rooms).toHaveLength(1);
  });
});

describe("choosing a physical room", () => {
  const T2 = "33333333-3333-4333-8333-333333333333";
  const ROOM = "6f1c1c1e-2b7a-4a55-9a43-1d2a8d9a1f10";
  const ROOM2 = "7a2d2d2f-3c8b-4b66-8b54-2e3b9e0b2a21";
  it("sends no room choice by default, and a chosen room for the slot it was chosen on", () => {
    const none = validateNewReservation({ ...base, roomId: "" });
    expect(none.ok && roomsPayload(none.value)[0]!.requested_room_id).toBeNull();
    const one = validateNewReservation({ ...base, roomId: ROOM, roomTypeId_2: T2, roomId_2: ROOM2 });
    expect(one.ok && roomsPayload(one.value).map((x) => x.requested_room_id)).toEqual([ROOM, ROOM2]);
    const second = validateNewReservation({ ...base, roomTypeId_2: T2, roomId_2: ROOM2 });
    expect(second.ok && roomsPayload(second.value).map((x) => x.requested_room_id)).toEqual([null, ROOM2]);
  });
  it("refuses a room choice that is not an id, and ignores a choice on an unused slot", () => {
    expect(bad({ roomId: "room 204" })).toBe("room_choice");
    expect(bad({ roomTypeId_2: T2, roomId_2: "x" })).toBe("room_choice");
    const r = validateNewReservation({ ...base, roomId_3: ROOM });
    expect(r.ok && r.value.rooms).toHaveLength(1);
  });
  it("words a room that is not of the chosen type, and a taken room, without raw database text", () => {
    expect(classifyRpcError("NOT_FOUND: requested room").code).toBe("room_choice");
    expect(errorMessage("room_choice", null, String)).toMatch(/does not belong to the room type/);
    expect(errorMessage("room_choice", null, String)).not.toMatch(/NOT_FOUND|POLICY_/);
    expect(errorMessage("room_unavailable", null, String)).toMatch(/the room you chose is taken/);
    expect(errorMessage("room_unavailable", null, String)).toMatch(/Nothing was booked/);
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
