import { describe, expect, it } from "vitest";
import { parseCreateBooking, parseIdempotencyKey } from "@/lib/api/booking-input";

const ROOM = "00000000-0000-0000-0000-0000000000a3";
const good = {
  arrival: "2027-02-01",
  departure: "2027-02-03",
  room_type_id: ROOM,
  guest: { full_name: "Ada Obi", email: "ADA@Example.com", phone: "0803 111 2222" },
};

describe("create booking input", () => {
  it("fills defaults, lower-cases the email and parses the stay", () => {
    expect(parseCreateBooking(good)).toMatchObject({
      ok: true,
      value: {
        adults: 2,
        children: 0,
        quantity: 1,
        guest: { email: "ada@example.com" },
        stay: { arrival: "2027-02-01", departure: "2027-02-03", adults: 2, children: 0 },
      },
    });
  });
  it("accepts a promo code, several rooms and guests", () => {
    expect(parseCreateBooking({ ...good, quantity: 3, adults: 3, children: 1, promo_code: "SPRING10" })).toMatchObject({
      ok: true,
      value: { quantity: 3, adults: 3, children: 1, promo_code: "SPRING10" },
    });
  });
  it("refuses unknown fields, bad dates, odd numbers and missing guest details", () => {
    for (const bad of [
      { price: 1 },
      { departure: "2027-02-01" },
      { arrival: "tomorrow" },
      { quantity: 6 },
      { quantity: 0 },
      { adults: 0 },
      { adults: "2" },
      { room_type_id: "nope" },
      { guest: { full_name: "A", email: "x" } },
      { guest: { ...good.guest, promo_code: "SNEAK" } },
      { guest: { ...good.guest, role: "admin" } },
    ]) {
      expect(parseCreateBooking({ ...good, ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(parseCreateBooking(null)).toMatchObject({ ok: false });
    expect(parseCreateBooking("x")).toMatchObject({ ok: false });
    expect(parseCreateBooking({})).toMatchObject({ ok: false });
  });
  it("names the field at fault", () => {
    const r = parseCreateBooking({ ...good, guest: { full_name: "Ada", email: "not-an-email" } });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.message).toContain("guest.email");
  });
  it("idempotency key: 8 to 100 safe characters", () => {
    expect(parseIdempotencyKey("order-12345")).toBe("order-12345");
    expect(parseIdempotencyKey("  order-12345 ")).toBe("order-12345");
    expect(parseIdempotencyKey("short")).toBeNull();
    expect(parseIdempotencyKey("has space in it")).toBeNull();
    expect(parseIdempotencyKey("a".repeat(101))).toBeNull();
    expect(parseIdempotencyKey("")).toBeNull();
    expect(parseIdempotencyKey(null)).toBeNull();
  });
});
