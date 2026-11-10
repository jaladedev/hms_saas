import { describe, expect, it } from "vitest";
import {
  classifySetupError,
  isRoomStatus,
  isRoomTypeStatus,
  nameClashes,
  parseAmenities,
  slugify,
  validateRoom,
  validateRoomType,
  validateRoomTypeEdit,
} from "./room-setup";
import { errorMessage, OK_MESSAGES } from "./refunds";

const P = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const type = {
  propertyId: P,
  name: "  Deluxe  Double ",
  code: "dlx",
  maxAdults: "2",
  maxChildren: "1",
  maxOccupancy: "",
  baseRate: "45,000",
  description: "",
  isPublic: "on",
};
const badType = (over: Record<string, unknown>) => {
  const r = validateRoomType({ ...type, ...over });
  return r.ok ? "ok" : r.code;
};

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
    expect(validateRoomType(type)).toEqual({
      ok: true,
      value: {
        propertyId: P,
        name: "Deluxe Double",
        code: "DLX",
        slug: "deluxe-double",
        description: null,
        amenities: [],
        maxAdults: 2,
        maxChildren: 1,
        maxOccupancy: 3,
        baseRateMinor: 4500000,
        isPublic: true,
      },
    });
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
    expect(badType({ maxOccupancy: "4" })).toBe("setup_invalid"); // more than 2 adults + 1 child
    expect(badType({ name: "N".repeat(81) })).toBe("setup_invalid"); // refused, not cut to 80
    expect(badType({ code: "ABCDEFGHIJKLM" })).toBe("setup_invalid"); // 13 characters
    expect(badType({ description: "d".repeat(501) })).toBe("setup_invalid");
    expect(badType({ baseRate: "0" })).toBe("amount_invalid");
    expect(badType({ baseRate: "free" })).toBe("amount_invalid");
  });
});

describe("validateRoom", () => {
  it("accepts a number with or without a floor", () => {
    expect(validateRoom({ roomTypeId: T, roomNumber: " 101A ", floor: "1" })).toEqual({
      ok: true,
      value: { roomTypeId: T, roomNumber: "101A", floor: 1 },
    });
    expect(validateRoom({ roomTypeId: T, roomNumber: "G-2", floor: "" })).toEqual({
      ok: true,
      value: { roomTypeId: T, roomNumber: "G-2", floor: null },
    });
    expect(validateRoom({ roomTypeId: T, roomNumber: "B1", floor: "-1" })).toMatchObject({ ok: true, value: { floor: -1 } });
  });
  it("refuses bad ids, numbers and floors", () => {
    expect(validateRoom({ roomTypeId: "x", roomNumber: "1" })).toEqual({ ok: false, code: "bad_request" });
    for (const n of ["", "  ", "-1", "a b", "12345678901", "10/2"])
      expect(validateRoom({ roomTypeId: T, roomNumber: n }), n).toEqual({ ok: false, code: "setup_invalid" });
    expect(validateRoom({ roomTypeId: T, roomNumber: "1", floor: "high" })).toEqual({ ok: false, code: "setup_invalid" });
    expect(validateRoom({ roomTypeId: T, roomNumber: "1", floor: "999" })).toEqual({ ok: false, code: "setup_invalid" });
  });
});

describe("classifySetupError and wording", () => {
  it("recognises duplicates, permission and bad values", () => {
    expect(
      classifySetupError({ code: "23505", message: 'duplicate key value violates unique constraint "room_types_property_id_code_key"' }),
    ).toBe("setup_duplicate_code");
    expect(
      classifySetupError({ code: "23505", message: 'duplicate key value violates unique constraint "room_types_property_id_slug_key"' }),
    ).toBe("setup_duplicate_name");
    expect(
      classifySetupError({ code: "23505", message: 'duplicate key value violates unique constraint "rooms_property_id_room_number_key"' }),
    ).toBe("setup_duplicate_room");
    expect(classifySetupError({ code: "42501", message: "x" })).toBe("setup_forbidden");
    expect(classifySetupError({ message: 'new row violates row-level security policy for table "rooms"' })).toBe("setup_forbidden");
    expect(classifySetupError({ code: "23514", message: "check" })).toBe("setup_invalid");
    expect(classifySetupError({ message: "boom" })).toBe("unknown");
  });
  it("words every new code and never echoes database text", () => {
    for (const c of [
      "setup_invalid",
      "setup_duplicate_code",
      "setup_duplicate_name",
      "setup_duplicate_room",
      "setup_forbidden",
      "room_has_bookings",
    ]) {
      expect(errorMessage(c, null, String), c).not.toMatch(/Nothing was changed|constraint|row-level/);
    }
  });
  it("knows the three room statuses", () => {
    expect(["active", "out_of_service", "retired"].every(isRoomStatus)).toBe(true);
    expect(isRoomStatus("closed")).toBe(false);
  });
});

describe("validateRoomTypeEdit", () => {
  const edit = {
    roomTypeId: T,
    name: "  Deluxe  Double ",
    maxAdults: "2",
    maxChildren: "1",
    maxOccupancy: "3",
    baseRate: "45,000",
    description: " Garden view ",
    isPublic: "on",
  };
  const badEdit = (over: Record<string, unknown>) => {
    const r = validateRoomTypeEdit({ ...edit, ...over });
    return r.ok ? "ok" : r.code;
  };

  it("accepts a good form, cleans it and prices in kobo", () => {
    expect(validateRoomTypeEdit(edit)).toEqual({
      ok: true,
      value: {
        roomTypeId: T,
        name: "Deluxe Double",
        description: "Garden view",
        amenities: [],
        maxAdults: 2,
        maxChildren: 1,
        maxOccupancy: 3,
        baseRateMinor: 4500000,
        isPublic: true,
      },
    });
  });
  it("cannot change the code or the web address, even if they are sent", () => {
    const r = validateRoomTypeEdit({ ...edit, code: "NEW", slug: "new-slug" });
    expect(r.ok && Object.keys(r.value)).not.toContain("code");
    expect(r.ok && Object.keys(r.value)).not.toContain("slug");
    expect(r.ok && Object.keys(r.value)).not.toContain("propertyId");
  });
  it("accepts the price exactly as the edit form shows it, so saving without changes keeps it", () => {
    for (const kobo of [4500000, 4550050, 99]) {
      const shown = (kobo / 100).toFixed(2);
      const r = validateRoomTypeEdit({ ...edit, baseRate: shown });
      expect(r.ok && r.value.baseRateMinor, shown).toBe(kobo);
    }
  });
  it("treats an unticked public box as private and an empty description as none", () => {
    const r = validateRoomTypeEdit({ ...edit, isPublic: undefined, description: "  " });
    expect(r.ok && r.value.isPublic).toBe(false);
    expect(r.ok && r.value.description).toBe(null);
  });
  it("refuses what the add form refuses, with the same codes", () => {
    expect(badEdit({ roomTypeId: "nope" })).toBe("bad_request");
    expect(badEdit({ name: "" })).toBe("setup_invalid");
    expect(badEdit({ name: "x".repeat(81) })).toBe("setup_invalid");
    expect(badEdit({ maxAdults: "0" })).toBe("setup_invalid");
    expect(badEdit({ maxAdults: "1", maxChildren: "0", maxOccupancy: "3" })).toBe("setup_invalid");
    expect(badEdit({ baseRate: "abc" })).toBe("amount_invalid");
    expect(badEdit({ baseRate: "0.00" })).toBe("amount_invalid"); // a standard price of zero is never allowed, as when adding
    expect(badEdit({ description: "x".repeat(501) })).toBe("setup_invalid");
  });
});

describe("parseAmenities", () => {
  it("splits on commas, semicolons and lines, tidies spaces and drops blanks", () => {
    expect(parseAmenities("  Air   conditioning, Wi-Fi ;\n\nBreakfast included\r\n, ,")).toEqual([
      "Air conditioning",
      "Wi-Fi",
      "Breakfast included",
    ]);
  });
  it("collapses repeats ignoring case to the first spelling, keeping order", () => {
    expect(parseAmenities("Wi-Fi, TV, wi-fi, tv, Safe")).toEqual(["Wi-Fi", "TV", "Safe"]);
  });
  it("treats nothing, blanks and non-text as an empty list", () => {
    expect(parseAmenities("")).toEqual([]);
    expect(parseAmenities(" , ;\n ")).toEqual([]);
    expect(parseAmenities(undefined)).toEqual([]);
    expect(parseAmenities(42)).toEqual([]);
  });
  it("keeps 20 items and 40 characters, refuses one more of either rather than cutting", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `Item ${i}`).join(", ");
    expect(parseAmenities(twenty)).toHaveLength(20);
    expect(parseAmenities(`${twenty}, Item 20`)).toBeNull();
    expect(parseAmenities("x".repeat(40))).toEqual(["x".repeat(40)]);
    expect(parseAmenities("x".repeat(41))).toBeNull();
    expect(parseAmenities("a, ".repeat(1000))).toBeNull();
  });
  it("counts items after repeats are collapsed", () => {
    const dupes = Array.from({ length: 30 }, () => "Wi-Fi").join(", ");
    expect(parseAmenities(dupes)).toEqual(["Wi-Fi"]);
  });
});

describe("amenities on the room type forms", () => {
  it("are read on add and on edit, and a bad list refuses the whole form", () => {
    const add = validateRoomType({ ...type, amenities: "Wi-Fi, Air conditioning" });
    expect(add.ok && add.value.amenities).toEqual(["Wi-Fi", "Air conditioning"]);
    const edit = validateRoomTypeEdit({
      roomTypeId: T,
      name: "Deluxe",
      maxAdults: "2",
      baseRate: "10,000",
      amenities: " Safe ,safe, Balcony ",
    });
    expect(edit.ok && edit.value.amenities).toEqual(["Safe", "Balcony"]);
    expect(badType({ amenities: "x".repeat(41) })).toBe("setup_invalid");
    const bad = validateRoomTypeEdit({ roomTypeId: T, name: "Deluxe", maxAdults: "2", baseRate: "10,000", amenities: "x".repeat(41) });
    expect(bad.ok ? "ok" : bad.code).toBe("setup_invalid");
  });
});

describe("room type status and name clashes", () => {
  it("knows the two room type statuses", () => {
    expect(isRoomTypeStatus("active") && isRoomTypeStatus("inactive")).toBe(true);
    expect(isRoomTypeStatus("retired")).toBe(false);
    expect(isRoomTypeStatus(undefined)).toBe(false);
  });
  it("catches a rename onto another type's name or web address, ignoring case and spacing", () => {
    const others = [
      { name: "Deluxe Double", slug: "deluxe-double" },
      { name: "Standard", slug: "standard" },
    ];
    expect(nameClashes("deluxe double", others)).toBe(true);
    expect(nameClashes("  STANDARD ", others)).toBe(true);
    expect(nameClashes("Deluxe, Double!", others)).toBe(true); // same web address
    expect(nameClashes("Suite", others)).toBe(false);
    expect(nameClashes("Suite", [])).toBe(false);
  });
  it("words the new results", () => {
    for (const c of ["room_type_updated", "room_type_deactivated", "room_type_activated"] as const)
      expect(OK_MESSAGES[c].length).toBeGreaterThan(10);
    expect(OK_MESSAGES.room_type_deactivated).toMatch(/Existing bookings are not affected/);
  });
});
