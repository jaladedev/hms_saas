import { describe, expect, it } from "vitest";
import {
  classifySvcError,
  nextActions,
  parseBookForm,
  parseBookings,
  parseServiceForm,
  parseServiceReport,
  parseServices,
  parseStepForm,
} from "./services";

const P = "00000000-0000-0000-0000-0000000000a2";
const S = "11111111-1111-1111-1111-111111111111";
const KEY = "abcdefgh12345";

describe("error words", () => {
  it("maps database refusals to codes", () => {
    expect(classifySvcError("NOT_FOUND")).toBe("svc_forbidden");
    expect(classifySvcError("POLICY_VIOLATION: services off")).toBe("svc_off");
    expect(classifySvcError("POLICY_VIOLATION: slot full")).toBe("svc_full");
    expect(classifySvcError("POLICY_VIOLATION: time")).toBe("svc_time");
    expect(classifySvcError("POLICY_VIOLATION: name taken")).toBe("svc_name_taken");
    expect(classifySvcError("INVALID_STATE: no room bill")).toBe("svc_no_room");
    expect(classifySvcError("INVALID_STATE: confirmed")).toBe("svc_not_in_house");
    expect(classifySvcError("INVALID_STATE: reservation")).toBe("svc_reservation");
    expect(classifySvcError("INVALID_STATE: charged")).toBe("svc_step");
    expect(classifySvcError("FORBIDDEN: folio.charge")).toBe("svc_need_folio");
    expect(classifySvcError("boom")).toBe("svc_failed");
  });
});

describe("reading", () => {
  it("reads services and bookings with totals", () => {
    const s = parseServices([
      { id: S, name: "Massage", kind: "spa", price_minor: 2500000, duration_minutes: 60, capacity: 1, is_active: true },
      { id: "b", name: "L", kind: "weird", price_minor: "800000", duration_minutes: null },
    ]);
    expect(s[0]).toMatchObject({ durationMinutes: 60, kind: "spa" });
    expect(s[1]).toMatchObject({ kind: "other", durationMinutes: null, priceMinor: 800000, capacity: 1 });
    const b = parseBookings([
      { id: "x", quantity: 2, unit_price_minor: 800000, status: "charged", kind_at_booking: "laundry", reservation_id: S },
    ]);
    expect(b[0]).toMatchObject({ totalMinor: 1600000, status: "charged", kind: "laundry" });
    expect(parseBookings(null)).toEqual([]);
  });
  it("keeps hidden revenue as null", () => {
    const r = parseServiceReport({ revenue_minor: null, services: [{ service_id: S, name: "Massage", revenue_minor: null, booked: 2 }] });
    expect(r.revenueMinor).toBeNull();
    expect(r.services[0]?.revenueMinor).toBeNull();
    expect(r.services[0]?.booked).toBe(2);
  });
});

describe("next steps", () => {
  it("offers the room bill only with a reservation", () => {
    expect(nextActions("booked", true).map((a) => a.action)).toEqual(["done", "charge", "no_show", "cancel"]);
    expect(nextActions("booked", false).map((a) => a.action)).toEqual(["done", "no_show", "cancel"]);
    expect(nextActions("done", true).map((a) => a.action)).toEqual(["charge"]);
    expect(nextActions("done", false)).toEqual([]);
    expect(nextActions("charged", true)).toEqual([]);
    expect(nextActions("cancelled", true)).toEqual([]);
  });
});

describe("service form", () => {
  const base = { propertyId: P, name: "Massage", kind: "spa", price: "25000", duration: "60", capacity: "1" };
  it("converts the price and treats a blank length as no slots", () => {
    expect(parseServiceForm(base)).toMatchObject({ ok: true, value: { priceMinor: 2500000, durationMinutes: 60 } });
    expect(parseServiceForm({ ...base, duration: "" })).toMatchObject({ ok: true, value: { durationMinutes: null } });
  });
  it("refuses bad values", () => {
    for (const bad of [{ name: "" }, { kind: "pool" }, { price: "0" }, { duration: "3" }, { capacity: "0" }, { propertyId: "no" }])
      expect(parseServiceForm({ ...base, ...bad }).ok).toBe(false);
  });
});

describe("booking form", () => {
  const base = { propertyId: P, serviceId: S, guestLabel: "Ade", startsAt: "2026-12-01T10:00", quantity: "1", key: KEY };
  it("takes a reference or a walk-in name, and a real local time", () => {
    expect(parseBookForm(base)).toMatchObject({ ok: true, value: { startsAt: "2026-12-01T10:00:00", reference: null } });
    expect(parseBookForm({ ...base, guestLabel: "", reference: "abc123" })).toMatchObject({ ok: true, value: { reference: "ABC123" } });
    expect(parseBookForm({ ...base, startsAt: "" })).toMatchObject({ ok: true, value: { startsAt: null } });
  });
  it("refuses no guest, a bad time, a bad quantity or a bad key", () => {
    expect(parseBookForm({ ...base, guestLabel: "" }).ok).toBe(false);
    expect(parseBookForm({ ...base, startsAt: "2026-13-40T10:00" }).ok).toBe(false);
    expect(parseBookForm({ ...base, quantity: "0" }).ok).toBe(false);
    expect(parseBookForm({ ...base, key: "x" }).ok).toBe(false);
  });
});

describe("step form", () => {
  it("accepts the four steps only", () => {
    expect(parseStepForm({ bookingId: S, action: "charge" }).ok).toBe(true);
    expect(parseStepForm({ bookingId: S, action: "refund" }).ok).toBe(false);
    expect(parseStepForm({ bookingId: "x", action: "done" }).ok).toBe(false);
  });
});
