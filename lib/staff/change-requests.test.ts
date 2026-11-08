import { describe, expect, it } from "vitest";
import { askText, kindLabel, parseRequests, parseRequestView, statusLabel, withBookings, type ChangeRequestRow } from "./change-requests";
import { errorMessage, OK_MESSAGES, classifyRpcError } from "./refunds";

const row = (o: Partial<ChangeRequestRow>): ChangeRequestRow => ({
  id: "1", property_id: "p", reservation_id: "r", kind: "dates", requested_arrival: "2026-12-01", requested_departure: "2026-12-03", message: null,
  status: "open", resolution_note: null, created_at: "", resolved_at: null,
  reservations: { booking_reference: "ABC", arrival_date: "2026-11-30", departure_date: "2026-12-02" }, ...o,
});
const fmt = (d: string) => `<${d}>`;

describe("change request queue", () => {
  it("shows the ask, with the booked dates beside new dates", () => {
    expect(askText(row({}), fmt)).toBe("Different dates: <2026-12-01> to <2026-12-03> (booked <2026-11-30> to <2026-12-02>)");
    expect(askText(row({ reservations: null }), fmt)).toBe("Different dates: <2026-12-01> to <2026-12-03>");
    expect(askText(row({ kind: "room" }), fmt)).toBe("Different room");
    expect(kindLabel("other")).toBe("Message");
  });
  it("labels states and reads the view and rows defensively", () => {
    expect(["open", "done", "declined", "withdrawn"].map((s) => statusLabel(s as ChangeRequestRow["status"]))).toEqual(["Waiting", "Dealt with", "Declined", "Withdrawn by the guest"]);
    expect(parseRequestView("answered")).toBe("answered");
    expect(parseRequestView("anything")).toBe("open");
    expect(parseRequests(null)).toEqual([]);
    expect(parseRequests([row({}), null, { nope: 1 }])).toHaveLength(1);
  });
  it("puts each booking on its request, and leaves null when the booking is not visible", () => {
    const { reservations: _drop, ...bare } = row({});
    const out = withBookings([bare, { ...bare, id: "2", reservation_id: "other" }], [{ id: "r", booking_reference: "ABC", arrival_date: "2026-11-30", departure_date: "2026-12-02" }]);
    expect(out[0]?.reservations).toEqual({ booking_reference: "ABC", arrival_date: "2026-11-30", departure_date: "2026-12-02" });
    expect(out[1]?.reservations).toBeNull();
  });
  it("words the staff outcomes", () => {
    expect(classifyRpcError("POLICY_VIOLATION: outcome").code).toBe("request_note");
    expect(errorMessage("request_note", null, String)).toMatch(/short note/);
    expect(OK_MESSAGES.request_done).toMatch(/dealt with/);
    expect(OK_MESSAGES.request_declined).toMatch(/note/);
  });
});
