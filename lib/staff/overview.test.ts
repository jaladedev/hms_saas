import { describe, expect, it } from "vitest";
import type { DeskRow } from "./front-desk";
import { buildTasks, countCleaning, countRefunds, countRepairs, todayFigures, type RefundBrief, type RequestBrief } from "./overview";

const NOW = new Date("2026-10-31T12:00:00Z");
const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const row = (id: string): DeskRow => ({ id, property_id: "p", booking_reference: id, reservation_status: "checked_in", payment_status: "paid", arrival_date: "2026-10-30", departure_date: "2026-10-31", attention_reason: null });
const refund = (over: Partial<RefundBrief>): RefundBrief => ({ refund_status: "requested", requested_by: OTHER, attention_note: null, provider_call_started_at: null, ...over });

describe("countRefunds", () => {
  it("splits requests by who made them, and counts stuck payouts and approved ones", () => {
    const c = countRefunds([
      refund({}), refund({ requested_by: ME }), refund({ requested_by: null }),
      refund({ refund_status: "approved" }),
      refund({ refund_status: "processing", attention_note: "unknown" }),
      refund({ refund_status: "processing", provider_call_started_at: "2026-10-31T09:00:00Z" }),
      refund({ refund_status: "processing", provider_call_started_at: "2026-10-31T11:30:00Z" }),
      refund({ refund_status: "succeeded" }),
    ], ME, NOW);
    expect(c).toEqual({ stuck: 2, toApprove: 2, waitingOnOthers: 1, toPay: 1 });
  });
  it("counts every request as approvable when the viewer is unknown", () => {
    expect(countRefunds([refund({})], null, NOW).toApprove).toBe(1);
  });
});

const request = (over: Partial<RequestBrief>): RequestBrief => ({ status: "open", priority: "normal", assigned_to: null, due_at: null, ...over });

describe("countRepairs", () => {
  it("counts live requests, overdue ones and high or urgent ones, and ignores finished requests", () => {
    const c = countRepairs([
      request({}),
      request({ priority: "high" }),
      request({ priority: "urgent", status: "in_progress", assigned_to: ME }),
      request({ due_at: "2026-10-31T09:00:00Z" }),
      request({ due_at: "2026-10-31T15:00:00Z" }),
      request({ status: "resolved", priority: "urgent", due_at: "2026-10-30T09:00:00Z" }),
      request({ status: "cancelled", priority: "high" }),
    ], NOW);
    expect(c).toEqual({ open: 5, overdue: 1, highPriority: 2 });
  });
  it("is all zeros when nothing is visible", () => {
    expect(countRepairs([], NOW)).toEqual({ open: 0, overdue: 0, highPriority: 0 });
  });
});

describe("buildTasks", () => {
  const noRepairs = { open: 0, overdue: 0, highPriority: 0 };
  const none = { desk: { overdue: [], lateArrivals: [] }, flaggedReservations: 0, refunds: { stuck: 0, toApprove: 0, waitingOnOthers: 0, toPay: 0 }, repairs: noRepairs, failedEmails: 0 };
  it("is empty when nothing needs anyone, and ignores requests that wait on others", () => {
    expect(buildTasks(none)).toEqual([]);
    expect(buildTasks({ ...none, refunds: { ...none.refunds, waitingOnOthers: 4 } })).toEqual([]);
  });
  it("does not list open repairs that are neither overdue nor high priority", () => {
    expect(buildTasks({ ...none, repairs: { open: 6, overdue: 0, highPriority: 0 } })).toEqual([]);
  });
  it("lists only non-zero items, most urgent first, with correct plurals", () => {
    const t = buildTasks({
      desk: { overdue: [row("a")], lateArrivals: [row("b"), row("c")] }, flaggedReservations: 3,
      refunds: { stuck: 1, toApprove: 1, waitingOnOthers: 0, toPay: 2 }, repairs: { open: 5, overdue: 1, highPriority: 2 }, failedEmails: 1,
    });
    expect(t.map((x) => x.key)).toEqual(["overdue", "flagged", "stuck", "repairsOverdue", "toApprove", "toPay", "repairsHigh", "emails", "late"]);
    expect(t[0]?.label).toBe("guest is still in house past their departure date");
    expect(t[1]?.label).toBe("reservations are flagged for attention");
    expect(t[3]?.label).toBe("repair is overdue");
    expect(t[6]?.label).toBe("urgent or high-priority repairs are open");
    expect(t.filter((x) => x.tone === "critical").map((x) => x.key)).toEqual(["overdue", "flagged", "stuck", "repairsOverdue"]);
    expect(t.every((x) => x.href.startsWith("/app/"))).toBe(true);
    expect(t.filter((x) => x.key.startsWith("repairs")).every((x) => x.href === "/app/maintenance")).toBe(true);
  });
});

describe("todayFigures", () => {
  it("counts everyone checked in as in house, including those leaving today or overdue", () => {
    const f = todayFigures({ arrivals: [row("a"), row("b")], departures: [row("c")], inHouse: [row("d"), row("e")], overdue: [row("f")], lateArrivals: [row("g")] });
    expect(f).toEqual({ arriving: 2, departing: 1, inHouse: 4 });
  });
});

describe("countCleaning", () => {
  const room = (housekeeping_status: string, operational_status = "active") => ({ housekeeping_status, operational_status });
  it("counts dirty and in-progress rooms, and says how many of them are being cleaned now", () => {
    expect(countCleaning([room("dirty"), room("dirty"), room("in_progress"), room("clean"), room("inspected")])).toEqual({ toClean: 2, inProgress: 1, total: 3 });
  });
  it("leaves out retired rooms but counts a room that is out of service", () => {
    expect(countCleaning([room("dirty", "retired"), room("in_progress", "retired"), room("dirty", "out_of_service")])).toEqual({ toClean: 1, inProgress: 0, total: 1 });
  });
  it("is zero for no rooms, and ignores a status it does not know", () => {
    expect(countCleaning([])).toEqual({ toClean: 0, inProgress: 0, total: 0 });
    expect(countCleaning([room("mystery")])).toEqual({ toClean: 0, inProgress: 0, total: 0 });
  });
});
