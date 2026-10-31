import { describe, expect, it } from "vitest";
import { bucketFrontDesk, deskFlag, type DeskRow } from "./front-desk";

const TODAY = new Map([["p1", "2026-11-03"], ["p2", "2026-11-04"]]);

function row(over: Partial<DeskRow> & { id: string }): DeskRow {
  return {
    property_id: "p1", booking_reference: `REF-${over.id}`, reservation_status: "confirmed", payment_status: "paid",
    arrival_date: "2026-11-03", departure_date: "2026-11-06", attention_reason: null, ...over,
  };
}
const ids = (rows: DeskRow[]) => rows.map((r) => r.id);

describe("bucketFrontDesk", () => {
  it("sorts each reservation into its list", () => {
    const g = bucketFrontDesk([
      row({ id: "arr" }),
      row({ id: "dep", reservation_status: "checked_in", arrival_date: "2026-11-01", departure_date: "2026-11-03" }),
      row({ id: "stay", reservation_status: "checked_in", arrival_date: "2026-11-01", departure_date: "2026-11-05" }),
      row({ id: "over", reservation_status: "checked_in", arrival_date: "2026-10-28", departure_date: "2026-11-02" }),
      row({ id: "late", arrival_date: "2026-11-01", departure_date: "2026-11-05" }),
    ], TODAY);
    expect(ids(g.arrivals)).toEqual(["arr"]);
    expect(ids(g.departures)).toEqual(["dep"]);
    expect(ids(g.inHouse)).toEqual(["stay"]);
    expect(ids(g.overdue)).toEqual(["over"]);
    expect(ids(g.lateArrivals)).toEqual(["late"]);
  });

  it("judges each row against its own property's date", () => {
    const g = bucketFrontDesk([
      row({ id: "a", property_id: "p1", arrival_date: "2026-11-03" }),
      row({ id: "b", property_id: "p2", arrival_date: "2026-11-03", departure_date: "2026-11-06" }),   // p2's today is the 4th
    ], TODAY);
    expect(ids(g.arrivals)).toEqual(["a"]);
    expect(ids(g.lateArrivals)).toEqual(["b"]);
  });

  it("keeps a multi-room booking with one room still to arrive on the arrivals list too", () => {
    const g = bucketFrontDesk([row({ id: "m", reservation_status: "checked_in", arrival_date: "2026-11-03" })], TODAY);
    expect(ids(g.arrivals)).toEqual(["m"]);
    expect(ids(g.inHouse)).toEqual(["m"]);
  });

  it("ignores other statuses, future arrivals and unknown properties", () => {
    const g = bucketFrontDesk([
      row({ id: "x1", reservation_status: "pending" }),
      row({ id: "x2", reservation_status: "cancelled" }),
      row({ id: "x3", arrival_date: "2026-11-10", departure_date: "2026-11-12" }),
      row({ id: "x4", property_id: "unknown" }),
      row({ id: "x5", arrival_date: "2026-10-30", departure_date: "2026-11-03" }),   // ended today without arriving
    ], TODAY);
    for (const list of Object.values(g)) expect(list).toEqual([]);
  });

  it("orders each list by booking reference", () => {
    const g = bucketFrontDesk([row({ id: "b" }), row({ id: "a" }), row({ id: "c" })], TODAY);
    expect(ids(g.arrivals)).toEqual(["a", "b", "c"]);
  });
});

describe("deskFlag", () => {
  it("puts attention first, then money still owed", () => {
    expect(deskFlag(row({ id: "1", attention_reason: "paid_after_cancel", payment_status: "unpaid" }))).toBe("Needs attention");
    expect(deskFlag(row({ id: "2", payment_status: "unpaid" }))).toBe("Unpaid");
    expect(deskFlag(row({ id: "3", payment_status: "partially_paid" }))).toBe("Part paid");
    expect(deskFlag(row({ id: "4" }))).toBeNull();
  });
});
