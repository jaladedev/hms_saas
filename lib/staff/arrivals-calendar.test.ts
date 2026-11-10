import { describe, expect, it } from "vitest";
import { agendaTotals, buildAgenda, busyDays, type AgendaRow } from "./arrivals-calendar";
import { parseWindow } from "./room-calendar";

const w = parseWindow("2026-11-05", "7", "2026-11-05"); // 5 to 11 November
const r = (ref: string, arrival: string, departure: string, status = "confirmed", over: Partial<AgendaRow> = {}): AgendaRow => ({
  id: ref,
  property_id: "p",
  booking_reference: ref,
  primary_guest_id: "g",
  reservation_status: status,
  payment_status: "paid",
  arrival_date: arrival,
  departure_date: departure,
  ...over,
});
const day = (rows: AgendaRow[], date: string) => buildAgenda(rows, w).find((d) => d.date === date)!;

describe("buildAgenda", () => {
  it("has one entry per day of the window, in order", () => {
    const days = buildAgenda([], w);
    expect(days).toHaveLength(7);
    expect(days[0]!.date).toBe("2026-11-05");
    expect(days[6]!.date).toBe("2026-11-11");
    expect(days.every((d) => d.arrivals.length === 0 && d.departures.length === 0 && d.staying === 0)).toBe(true);
  });
  it("lists arrivals on the arrival day and departures on the departure day, sorted by booking number", () => {
    const rows = [r("HMS-10", "2026-11-06", "2026-11-08"), r("HMS-9", "2026-11-06", "2026-11-07"), r("HMS-2", "2026-11-04", "2026-11-06")];
    expect(day(rows, "2026-11-06").arrivals.map((x) => x.id)).toEqual(["HMS-9", "HMS-10"]);
    expect(day(rows, "2026-11-06").departures.map((x) => x.id)).toEqual(["HMS-2"]);
    expect(day(rows, "2026-11-07").departures.map((x) => x.id)).toEqual(["HMS-9"]);
    expect(day(rows, "2026-11-08").departures.map((x) => x.id)).toEqual(["HMS-10"]);
  });
  it("counts nights as staying: the arrival day yes, the departure day no", () => {
    const rows = [r("A", "2026-11-05", "2026-11-08")];
    expect([5, 6, 7, 8].map((n) => day(rows, `2026-11-0${n}`).staying)).toEqual([1, 1, 1, 0]);
  });
  it("counts a stay that began before the window and one that goes past it", () => {
    const rows = [r("A", "2026-11-01", "2026-11-06", "checked_in"), r("B", "2026-11-10", "2026-11-20")];
    expect(day(rows, "2026-11-05").staying).toBe(1);
    expect(day(rows, "2026-11-06").staying).toBe(0);
    expect(day(rows, "2026-11-11").staying).toBe(1);
    // listed only where it arrives or leaves, and those days are outside the window
    expect(agendaTotals(buildAgenda(rows, w))).toEqual({ arrivals: 1, departures: 1 });
  });
  it("lists a hold but does not count it as staying; never lists a cancelled or no-show booking", () => {
    const rows = [
      r("H", "2026-11-06", "2026-11-08", "pending"),
      r("X", "2026-11-06", "2026-11-08", "cancelled"),
      r("Z", "2026-11-06", "2026-11-08", "no_show"),
    ];
    expect(day(rows, "2026-11-06").arrivals.map((x) => x.id)).toEqual(["H"]);
    expect(day(rows, "2026-11-06").staying).toBe(0);
  });
  it("keeps a checked-out guest in the lists and the staying count", () => {
    const rows = [r("O", "2026-11-05", "2026-11-07", "checked_out")];
    expect(day(rows, "2026-11-05").arrivals).toHaveLength(1);
    expect(day(rows, "2026-11-07").departures).toHaveLength(1);
    expect(day(rows, "2026-11-06").staying).toBe(1);
  });
  it("lists a booking under both days when it arrives and leaves inside the window", () => {
    const rows = [r("A", "2026-11-06", "2026-11-09")];
    expect(agendaTotals(buildAgenda(rows, w))).toEqual({ arrivals: 1, departures: 1 });
  });
});

describe("busyDays", () => {
  it("keeps only days with an arrival or a departure", () => {
    const days = buildAgenda([r("A", "2026-11-06", "2026-11-09")], w);
    expect(busyDays(days).map((d) => d.date)).toEqual(["2026-11-06", "2026-11-09"]);
    expect(busyDays(buildAgenda([], w))).toEqual([]);
  });
});
