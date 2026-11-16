import { describe, expect, it } from "vitest";
import { barPercent, recentReservations, weekStrip } from "./dashboard";

const day = (date: string, sold: number, available: number) => ({
  date,
  rooms_total: available,
  rooms_blocked: 0,
  rooms_available: available,
  rooms_sold: sold,
  room_revenue_minor: 0,
  arrivals: 0,
  departures: 0,
  no_shows: 0,
});

describe("weekStrip", () => {
  it("takes today from the first day and gives up to seven days", () => {
    const days = Array.from({ length: 9 }, (_, i) => day(`2026-11-${String(16 + i)}`, i, 10));
    const w = weekStrip({ property_id: "p", days });
    expect(w?.today).toEqual({ sold: 0, available: 10, free: 10, bp: 0 });
    expect(w?.days).toHaveLength(7);
    expect(w?.days[3]).toEqual({ date: "2026-11-19", bp: 3000, sold: 3, available: 10 });
  });
  it("never shows a negative number of free rooms", () => {
    expect(weekStrip({ property_id: "p", days: [day("2026-11-16", 5, 4)] })?.today.free).toBe(0);
  });
  it("gives null for anything that is not a report", () => {
    expect(weekStrip(null)).toBeNull();
    expect(weekStrip({ property_id: "p", days: [] })).toBeNull();
    expect(weekStrip({ days: [day("d", 1, 1)] })).toBeNull();
    expect(weekStrip({ property_id: "p", days: [{ date: "x" }] })).toBeNull();
  });
  it("shows a dash-safe null percent when no rooms were available", () => {
    expect(weekStrip({ property_id: "p", days: [day("d", 0, 0)] })?.today.bp).toBeNull();
  });
});

describe("barPercent", () => {
  it("keeps bars between 4 and 100", () => {
    expect(barPercent(null)).toBe(4);
    expect(barPercent(0)).toBe(4);
    expect(barPercent(5000)).toBe(50);
    expect(barPercent(12000)).toBe(100);
  });
});

describe("recentReservations", () => {
  const ok = {
    id: "a",
    booking_reference: "BK-1",
    reservation_status: "confirmed",
    payment_status: "paid",
    total_minor: 100,
    currency: "NGN",
    arrival_date: "2026-11-20",
    primary_guest_id: null,
  };
  it("keeps good rows and drops the rest", () => {
    expect(recentReservations([ok, { id: "b" }, null])).toEqual([ok]);
    expect(recentReservations("x")).toEqual([]);
  });
});
