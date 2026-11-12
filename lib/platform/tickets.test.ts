import { describe, expect, it } from "vitest";
import { MAX_DETAILS, MAX_NOTE, MAX_TITLE, openCount, parseNewTicket, parseNote, readTicketDetail, readTickets } from "./tickets";

const T = "00000000-0000-4000-8000-0000000000a1";

describe("parseNewTicket", () => {
  it("tidies the title and defaults the priority", () => {
    expect(parseNewTicket({ tenantId: T, title: "  Paystack   webhook failing ", details: " Since Monday. " })).toEqual({
      tenantId: T,
      title: "Paystack webhook failing",
      details: "Since Monday.",
      priority: "normal",
    });
    expect(parseNewTicket({ tenantId: T, title: "Login help", priority: "high" })).toMatchObject({ priority: "high", details: "" });
  });
  it("refuses a bad hotel, title, details or priority", () => {
    const ok = { tenantId: T, title: "Fine title" };
    expect(parseNewTicket({ ...ok, tenantId: "x" })).toBeNull();
    expect(parseNewTicket({ ...ok, title: "ab" })).toBeNull();
    expect(parseNewTicket({ ...ok, title: "x".repeat(MAX_TITLE + 1) })).toBeNull();
    expect(parseNewTicket({ ...ok, title: "x".repeat(MAX_TITLE) })).not.toBeNull();
    expect(parseNewTicket({ ...ok, details: "x".repeat(MAX_DETAILS + 1) })).toBeNull();
    expect(parseNewTicket({ ...ok, priority: "urgent" })).toBeNull();
    expect(parseNewTicket({})).toBeNull();
  });
});

describe("parseNote", () => {
  it("trims, and refuses blank or too long", () => {
    expect(parseNote("  called them  ")).toBe("called them");
    expect(parseNote("   ")).toBeNull();
    expect(parseNote(null)).toBeNull();
    expect(parseNote("n".repeat(MAX_NOTE))).not.toBeNull();
    expect(parseNote("n".repeat(MAX_NOTE + 1))).toBeNull();
  });
});

describe("readers", () => {
  const row = {
    id: "k1",
    number: "TK-000001",
    tenant_id: T,
    tenant_name: "Bodija",
    title: "Hello",
    priority: "high",
    status: "in_progress",
    created_at: "2026-11-12",
    updated_at: "2026-11-12",
    notes: 2,
  };
  it("reads the list and drops what is not a ticket", () => {
    expect(readTickets([row, null, 5, { title: "no id" }])).toEqual([row]);
    expect(readTickets("x")).toEqual([]);
    expect(readTickets([{ ...row, priority: "weird", status: "weird", notes: -1 }])[0]).toMatchObject({
      priority: "normal",
      status: "open",
      notes: 0,
    });
  });
  it("reads a ticket with its notes, or null", () => {
    const d = readTicketDetail({
      ...row,
      details: "Why",
      resolved_at: null,
      notes: [{ id: "n1", note: "x", created_at: "t", author: "a@b.co" }, 7],
    });
    expect(d?.details).toBe("Why");
    expect(d?.notes).toHaveLength(2);
    expect(d?.notes[0]).toEqual({ id: "n1", note: "x", created_at: "t", author: "a@b.co" });
    expect(readTicketDetail(null)).toBeNull();
    expect(readTicketDetail({ title: "x" })).toBeNull();
  });
  it("counts the tickets that still need work", () => {
    expect(openCount([{ status: "open" }, { status: "in_progress" }, { status: "resolved" }, { status: "closed" }])).toBe(2);
  });
});
