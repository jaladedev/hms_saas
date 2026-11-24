import { describe, expect, it } from "vitest";
import {
  classifyFolioReplayError,
  classifyNoteReplayError,
  classifyReplayError,
  folioReplayBodySchema,
  noteReplayBodySchema,
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

describe("a booking note sent from offline", () => {
  const note = { id, action: "note_set", userId: id, reservationId: id, note: "Arrives late", expected: "" };
  it("accepts a note, a cleared note and the time it was made, and nothing else", () => {
    expect(noteReplayBodySchema.safeParse({ items: [note] }).success).toBe(true);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, note: "" }] }).success).toBe(true);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, madeAt: "2026-11-23T10:42:00.000Z" }] }).success).toBe(true);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, madeAt: "yesterday" }] }).success).toBe(false);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, action: "note_clear" }] }).success).toBe(false);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, reservationId: "x" }] }).success).toBe(false);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, expected: undefined }] }).success).toBe(false);
    expect(noteReplayBodySchema.safeParse({ items: [{ ...note, note: "x".repeat(1201) }] }).success).toBe(false);
    expect(noteReplayBodySchema.safeParse({ items: Array.from({ length: 51 }, () => note) }).success).toBe(false);
  });
  it("is told apart from a housekeeping step", () => {
    expect(replayBodySchema.safeParse({ items: [note] }).success).toBe(false);
  });
  it("says what to do with each refusal", () => {
    expect(classifyNoteReplayError("CONFLICT: staff note changed")).toEqual({ status: "rejected", reason: "changed" });
    expect(classifyNoteReplayError("POLICY_VIOLATION: staff note")).toEqual({ status: "rejected", reason: "invalid" });
    expect(classifyNoteReplayError("NOT_FOUND")).toEqual({ status: "rejected", reason: "no_access" });
    expect(classifyNoteReplayError("FORBIDDEN")).toEqual({ status: "rejected", reason: "no_access" });
    expect(classifyNoteReplayError("connection reset")).toEqual({ status: "retry" });
    expect(REASON_TEXT.changed).toMatch(/someone else changed the note/);
  });
});
