import { describe, expect, it } from "vitest";
import { classifyReplayError, replayBodySchema, REASON_TEXT } from "./replay";

const id = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const item = { id, action: "start", taskId: id, userId: id };

describe("replay body", () => {
  it("accepts the three housekeeping steps and nothing else", () => {
    for (const action of ["claim", "start", "complete"])
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
    for (const reason of ["taken", "cancelled", "missing", "forbidden", "other_user", "error"] as const)
      expect(REASON_TEXT[reason].length).toBeGreaterThan(5);
  });
});
