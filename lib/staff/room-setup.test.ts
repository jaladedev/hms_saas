import { describe, expect, it } from "vitest";
import { classifySetupError, isRoomStatus, slugify, validateRoom, validateRoomType } from "./room-setup";
import { errorMessage } from "./refunds";

const P = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const type = { propertyId: P, name: "  Deluxe  Double ", code: "dlx", maxAdults: "2", maxChildren: "1", maxOccupancy: "", baseRate: "45,000", description: "", isPublic: "on" };
const badType = (over: Record<string, unknown>) => { const r = validateRoomType({ ...type, ...over }); return r.ok ? "ok" : r.code; };

describe("slugify", () => {
  it("makes a URL-safe slug", () => {
    expect(slugify("Deluxe Double, Garden View")).toBe("deluxe-double-garden-view");
    expect(slugify("Crème Brûlée Suite")).toBe("creme-brulee-suite");
    expect(slugify("  --A  B--  ")).toBe("a-b");
    expect(slugify("★★★")).toBe("");
    expect(slugify("x".repeat(100))).toHaveLength(60);
  });
});

describe("validateRoomType", () => {
  it("accepts a good form, cleans it and prices in kobo", () => {
    expect(validateRoomType(type)).toEqual({ ok: true, value: {
      propertyId: P, name: "Deluxe Double", code: "DLX", slug: "deluxe-double", description: null,
      maxAdults: 2, maxChildren: 1, maxOccupancy: 3, baseRateMinor: 4500000, isPublic: true,
    } });
  });
  it("treats an unticked public box as private and keeps an explicit occupancy", () => {
    const r = validateRoomType({ ...type, isPublic: undefined, maxOccupancy: "2", description: " Garden facing " });
    expect(r.ok && r.value).toMatchObject({ isPublic: false, maxOccupancy: 2, description: "Garden facing" });
  });
  it("refuses bad input with a specific code", () => {
    expect(badType({ propertyId: "x" })).toBe("bad_request");
    expect(badType({ name: "   " })).toBe("setup_invalid");
    expect(badType({ name: "★★★" })).toBe("setup_invalid");
    expect(badType({ code: "a" })).toBe("setup_invalid");
    expect(badType({ code: "bad code!" })).toBe("setup_invalid");
    expect(badType({ maxAdults: "0" })).toBe("setup_invalid");
    expect(badType({ maxAdults: "two" })).toBe("setup_invalid");
    expect(badType({ maxChildren: "-1" })).toBe("setup_invalid");
    expect(badType({ maxOccupancy: "4" })).toBe("setup_invalid");   // more than 2 adults + 1 child
    expect(badType({ name: "N".repeat(81) })).toBe("setup_invalid");          // refused, not cut to 80
    expect(badType({ code: "ABCDEFGHIJKLM" })).toBe("setup_invalid");        // 13 characters
    expect(badType({ description: "d".repeat(501) })).toBe("setup_invalid");
    expect(badType({ baseRate: "0" })).toBe("amount_invalid");
    expect(badType({ baseRate: "free" })).toBe("amount_invalid");
  });
});

describe("validateRoom", () => {
  it("accepts a number with or without a floor", () => {
    expect(validateRoom({ roomTypeId: T, roomNumber: " 101A ", floor: "1" })).toEqual({ ok: true, value: { roomTypeId: T, roomNumber: "101A", floor: 1 } });
    expect(validateRoom({ roomTypeId: T, roomNumber: "G-2", floor: "" })).toEqual({ ok: true, value: { roomTypeId: T, roomNumber: "G-2", floor: null } });
    expect(validateRoom({ roomTypeId: T, roomNumber: "B1", floor: "-1" })).toMatchObject({ ok: true, value: { floor: -1 } });
  });
  it("refuses bad ids, numbers and floors", () => {
    expect(validateRoom({ roomTypeId: "x", roomNumber: "1" })).toEqual({ ok: false, code: "bad_request" });
    for (const n of ["", "  ", "-1", "a b", "12345678901", "10/2"]) expect(validateRoom({ roomTypeId: T, roomNumber: n }), n).toEqual({ ok: false, code: "setup_invalid" });
    expect(validateRoom({ roomTypeId: T, roomNumber: "1", floor: "high" })).toEqual({ ok: false, code: "setup_invalid" });
    expect(validateRoom({ roomTypeId: T, roomNumber: "1", floor: "999" })).toEqual({ ok: false, code: "setup_invalid" });
  });
});

describe("classifySetupError and wording", () => {
  it("recognises duplicates, permission and bad values", () => {
    expect(classifySetupError({ code: "23505", message: 'duplicate key value violates unique constraint "room_types_property_id_code_key"' })).toBe("setup_duplicate_code");
    expect(classifySetupError({ code: "23505", message: 'duplicate key value violates unique constraint "room_types_property_id_slug_key"' })).toBe("setup_duplicate_name");
    expect(classifySetupError({ code: "23505", message: 'duplicate key value violates unique constraint "rooms_property_id_room_number_key"' })).toBe("setup_duplicate_room");
    expect(classifySetupError({ code: "42501", message: "x" })).toBe("setup_forbidden");
    expect(classifySetupError({ message: 'new row violates row-level security policy for table "rooms"' })).toBe("setup_forbidden");
    expect(classifySetupError({ code: "23514", message: "check" })).toBe("setup_invalid");
    expect(classifySetupError({ message: "boom" })).toBe("unknown");
  });
  it("words every new code and never echoes database text", () => {
    for (const c of ["setup_invalid", "setup_duplicate_code", "setup_duplicate_name", "setup_duplicate_room", "setup_forbidden", "room_has_bookings"]) {
      expect(errorMessage(c, null, String), c).not.toMatch(/Nothing was changed|constraint|row-level/);
    }
  });
  it("knows the three room statuses", () => {
    expect(["active", "out_of_service", "retired"].every(isRoomStatus)).toBe(true);
    expect(isRoomStatus("closed")).toBe(false);
  });
});
