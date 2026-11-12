import { describe, expect, it } from "vitest";
import { awaitingDecision, parseAccessDecision, parseAccessRequest, readAccess, readSetup, timeLeft, type AccessRow } from "./access";

const T = "00000000-0000-0000-0000-0000000000a1";
const K = "00000000-0000-0000-0000-0000000000f1";
const ok = { tenantId: T, reason: "Looking into a payment problem", hours: "4" };

describe("parseAccessRequest", () => {
  it("reads a good form and trims the reason", () => {
    expect(parseAccessRequest({ ...ok, reason: "  Looking into a payment problem  ", ticketId: K })).toEqual({
      tenantId: T,
      reason: "Looking into a payment problem",
      hours: 4,
      ticketId: K,
    });
    expect(parseAccessRequest({ tenantId: T, reason: "Looking into a payment problem" })?.hours).toBe(1);
    expect(parseAccessRequest(ok)?.ticketId).toBeNull();
  });
  it("refuses a short or long reason, odd hours, bad ids", () => {
    for (const over of [
      { reason: "too short" },
      { reason: "x".repeat(501) },
      { hours: "2" },
      { hours: "48" },
      { hours: "abc" },
      { tenantId: "nope" },
      { ticketId: "nope" },
    ]) {
      expect(parseAccessRequest({ ...ok, ...over })).toBeNull();
    }
    expect(parseAccessRequest({ ...ok, reason: "x".repeat(500) })).not.toBeNull();
  });
});

describe("parseAccessDecision", () => {
  it("accepts approve or deny with an optional note", () => {
    expect(parseAccessDecision({ requestId: K, decision: "approved" })).toEqual({ requestId: K, decision: "approved", note: "" });
    expect(parseAccessDecision({ requestId: K, decision: "denied", note: " Not needed " })?.note).toBe("Not needed");
  });
  it("refuses anything else", () => {
    for (const raw of [
      { requestId: K, decision: "maybe" },
      { requestId: K },
      { requestId: "x", decision: "approved" },
      { requestId: K, decision: "approved", note: "x".repeat(301) },
    ]) {
      expect(parseAccessDecision(raw)).toBeNull();
    }
  });
});

const row = (over: Partial<AccessRow>): AccessRow => ({
  id: K,
  tenant_id: T,
  tenant_name: "Hotel",
  reason: "r",
  hours: 1,
  ticket_number: null,
  status: "pending",
  requested_at: "2026-11-12T10:00:00Z",
  requested_by_email: null,
  decided_by_email: null,
  decided_at: null,
  decision_note: null,
  approved_until: null,
  views: 0,
  last_viewed_at: null,
  mine: false,
  ...over,
});

describe("readers", () => {
  it("keeps only well-formed rows", () => {
    expect(readAccess(null)).toEqual([]);
    expect(readAccess({})).toEqual([]);
    expect(readAccess([row({}), { id: 1 }, null, row({ status: "bogus" as never })])).toHaveLength(1);
  });
  it("lists pending requests oldest first", () => {
    const rows = [
      row({ id: "b", requested_at: "2026-11-12T12:00:00Z" }),
      row({ id: "a", requested_at: "2026-11-12T09:00:00Z" }),
      row({ id: "c", status: "approved" }),
    ];
    expect(awaitingDecision(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("reads a setup view and refuses a malformed one", () => {
    expect(readSetup(null)).toBeNull();
    expect(readSetup({ tenant_name: "x" })).toBeNull();
    const s = readSetup({
      tenant_name: "x",
      tenant_status: "active",
      approved_until: "2026-11-12T10:00:00Z",
      properties: [],
      features: [],
      domains: [],
    });
    expect(s?.roles).toEqual([]);
    expect(s?.payment_accounts).toEqual([]);
  });
});

describe("timeLeft", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  it("words the time left in an approved window", () => {
    expect(timeLeft({ status: "approved", approved_until: "2026-11-12T12:05:00Z" }, now)).toBe("2 hours 5 minutes left");
    expect(timeLeft({ status: "approved", approved_until: "2026-11-12T11:00:00Z" }, now)).toBe("1 hour left");
    expect(timeLeft({ status: "approved", approved_until: "2026-11-12T10:12:00Z" }, now)).toBe("12 minutes left");
    expect(timeLeft({ status: "approved", approved_until: "2026-11-12T10:00:30Z" }, now)).toBe("1 minute left");
  });
  it("is null when there is no running window", () => {
    expect(timeLeft({ status: "approved", approved_until: "2026-11-12T09:59:00Z" }, now)).toBeNull();
    expect(timeLeft({ status: "pending", approved_until: null }, now)).toBeNull();
    expect(timeLeft({ status: "revoked", approved_until: "2026-11-12T12:00:00Z" }, now)).toBeNull();
    expect(timeLeft({ status: "approved", approved_until: "junk" }, now)).toBeNull();
  });
});
