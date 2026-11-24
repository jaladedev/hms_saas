import { describe, expect, it } from "vitest";
import {
  classifyFolioReplayError,
  classifyReplayError,
  folioReplayBodySchema,
  offlinePaymentNote,
  replayBodySchema,
  REASON_TEXT,
} from "./replay";

const id = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const item = { id, action: "start", taskId: id, userId: id };

describe("replay body", () => {
  it("accepts the housekeeping and repair steps and nothing else", () => {
    for (const action of ["claim", "start", "complete", "maint_claim", "maint_start", "maint_resolve"])
      expect(replayBodySchema.safeParse({ items: [{ ...item, action }] }).success).toBe(true);
    for (const action of ["cancel", "assign", "create", ""])
      expect(replayBodySchema.safeParse({ items: [{ ...item, action }] }).success).toBe(false);
  });
  it("refuses bad ids, long notes and too many items", () => {
    expect(replayBodySchema.safeParse({ items: [{ ...item, taskId: "x" }] }).success).toBe(false);
    expect(replayBodySchema.safeParse({ items: [{ ...item, action: "complete", note: "x".repeat(501) }] }).success).toBe(false);
    expect(replayBodySchema.safeParse({ items: Array.from({ length: 51 }, () => item) }).success).toBe(false);
    expect(replayBodySchema.safeParse({ items: [] }).success).toBe(true);
  });
});

describe("notes on repairs", () => {
  it("allow 1000 characters on a repair and 500 on a housekeeping task, as the database does", () => {
    const ok = (action: string, n: number) => replayBodySchema.safeParse({ items: [{ ...item, action, note: "x".repeat(n) }] }).success;
    expect(ok("maint_resolve", 1000)).toBe(true);
    expect(ok("maint_resolve", 1001)).toBe(false);
    expect(ok("complete", 500)).toBe(true);
    expect(ok("complete", 501)).toBe(false);
  });
});

describe("what to do with a database refusal for a repair", () => {
  it("treats a repair already resolved as done, and one cancelled as a problem", () => {
    expect(classifyReplayError("maint_start", "INVALID_STATE: request resolved")).toEqual({ status: "already" });
    expect(classifyReplayError("maint_claim", "INVALID_STATE: request resolved")).toEqual({ status: "already" });
    expect(classifyReplayError("maint_resolve", "INVALID_STATE: request cancelled")).toEqual({ status: "rejected", reason: "cancelled" });
  });
  it("treats a repair someone else took as a problem", () => {
    expect(classifyReplayError("maint_claim", "FORBIDDEN: assigned to someone else")).toEqual({ status: "rejected", reason: "taken" });
  });
});

describe("what to do with a database refusal", () => {
  it("treats a task already past this step as done, not as a problem", () => {
    expect(classifyReplayError("start", "INVALID_STATE: task done")).toEqual({ status: "already" });
    expect(classifyReplayError("claim", "INVALID_STATE: task done")).toEqual({ status: "already" });
  });
  it("gives a reason for what will never work", () => {
    expect(classifyReplayError("claim", "FORBIDDEN: assigned to someone else")).toEqual({ status: "rejected", reason: "taken" });
    expect(classifyReplayError("start", "INVALID_STATE: task cancelled")).toEqual({ status: "rejected", reason: "cancelled" });
    expect(classifyReplayError("complete", "INVALID_STATE: task cancelled")).toEqual({ status: "rejected", reason: "cancelled" });
    expect(classifyReplayError("start", "NOT_FOUND")).toEqual({ status: "rejected", reason: "missing" });
    expect(classifyReplayError("start", "FORBIDDEN")).toEqual({ status: "rejected", reason: "forbidden" });
    expect(classifyReplayError("complete", "POLICY_VIOLATION: note too long")).toEqual({ status: "rejected", reason: "error" });
  });
  it("retries anything it does not recognise", () => {
    expect(classifyReplayError("start", "connection terminated unexpectedly")).toEqual({ status: "retry" });
    expect(classifyReplayError("start", "")).toEqual({ status: "retry" });
  });
  it("has wording for every reason it can give", () => {
    for (const reason of [
      "taken",
      "cancelled",
      "missing",
      "forbidden",
      "other_user",
      "error",
      "not_open",
      "overpay",
      "invalid",
      "no_access",
    ] as const)
      expect(REASON_TEXT[reason].length).toBeGreaterThan(5);
  });
});

const folioItem = { id, action: "folio_charge", userId: id, reservationId: id, fields: { description: "Water", amount: "500" } };

describe("folio replay body", () => {
  it("accepts a charge and a payment and nothing else", () => {
    for (const action of ["folio_charge", "folio_payment"])
      expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, action }] }).success).toBe(true);
    for (const action of ["folio_void", "folio_reverse", "start", "check_out", ""])
      expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, action }] }).success).toBe(false);
  });
  it("refuses bad ids, odd fields and too many items", () => {
    expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, reservationId: "x" }] }).success).toBe(false);
    expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, id: "x" }] }).success).toBe(false);
    expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, fields: { a: 1 } }] }).success).toBe(false);
    expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, fields: { a: "x".repeat(601) } }] }).success).toBe(false);
    expect(folioReplayBodySchema.safeParse({ items: Array.from({ length: 51 }, () => folioItem) }).success).toBe(false);
    expect(folioReplayBodySchema.safeParse({ items: [{ ...folioItem, madeAt: "yesterday" }] }).success).toBe(false);
  });
  it("is not a housekeeping body, and the reverse", () => {
    expect(replayBodySchema.safeParse({ items: [folioItem] }).success).toBe(false);
    expect(folioReplayBodySchema.safeParse({ items: [item] }).success).toBe(false);
  });
});

describe("what to do with a database refusal of a folio change", () => {
  it("gives a reason for what will never work", () => {
    expect(classifyFolioReplayError("POLICY_VIOLATION: OVERPAYMENT outstanding 500")).toEqual({ status: "rejected", reason: "overpay" });
    expect(classifyFolioReplayError("INVALID_STATE: cancelled")).toEqual({ status: "rejected", reason: "not_open" });
    expect(classifyFolioReplayError("NOT_FOUND")).toEqual({ status: "rejected", reason: "no_access" });
    expect(classifyFolioReplayError("FORBIDDEN")).toEqual({ status: "rejected", reason: "no_access" });
    expect(classifyFolioReplayError("POLICY_VIOLATION: date")).toEqual({ status: "rejected", reason: "invalid" });
    expect(classifyFolioReplayError("IDEMPOTENCY_MISMATCH")).toEqual({ status: "rejected", reason: "error" });
  });
  it("retries anything it does not recognise", () => {
    expect(classifyFolioReplayError("connection terminated unexpectedly")).toEqual({ status: "retry" });
    expect(classifyFolioReplayError("")).toEqual({ status: "retry" });
  });
});

describe("the note on a payment taken offline", () => {
  const now = new Date("2026-11-23T15:00:00Z");
  it("says when the money was really taken, in UTC, after the person's own note", () => {
    expect(offlinePaymentNote("paid at desk", "2026-11-23T14:05:44.000Z", now)).toBe(
      "paid at desk · Taken offline at 2026-11-23 14:05 UTC",
    );
    expect(offlinePaymentNote(null, "2026-11-23T14:05:44.000Z", now)).toBe("Taken offline at 2026-11-23 14:05 UTC");
    expect(offlinePaymentNote("  ", "2026-11-23T14:05:44.000Z", now)).toBe("Taken offline at 2026-11-23 14:05 UTC");
  });
  it("converts a time with a zone, and never says a time in the future", () => {
    expect(offlinePaymentNote(null, "2026-11-23T15:05:00+01:00", now)).toBe("Taken offline at 2026-11-23 14:05 UTC");
    expect(offlinePaymentNote(null, "2026-11-24T09:00:00Z", now)).toBe("Taken offline at 2026-11-23 15:00 UTC");
  });
  it("trims a long note to stay inside the database's 500 characters, keeping the time", () => {
    const out = offlinePaymentNote("n".repeat(500), "2026-11-23T14:05:00Z", now)!;
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("Taken offline at 2026-11-23 14:05 UTC")).toBe(true);
  });
  it("is just the person's note when there is no usable time, and null when there is nothing", () => {
    expect(offlinePaymentNote("paid", undefined, now)).toBe("paid");
    expect(offlinePaymentNote("paid", "soon", now)).toBe("paid");
    expect(offlinePaymentNote(null, undefined, now)).toBeNull();
  });
});
