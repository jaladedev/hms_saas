import { describe, expect, it } from "vitest";
import { evaluateHealth, httpStatusFor, type RawHealth } from "./ops-health";

const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const clean = (over: Partial<RawHealth> = {}): RawHealth => ({
  maintenance: { last_run_at: ago(2), last_ok_at: ago(2), last_error: null },
  emails_failed_7d: 0,
  emails_stuck: 0,
  payment_events_stuck: 0,
  payment_events_mismatch_7d: 0,
  refunds_stuck: 0,
  holds_overdue: 0,
  paid_inventory_lost: 0,
  attention_other: 0,
  ...over,
});

describe("evaluateHealth", () => {
  it("is ok when nothing is wrong", () => {
    const r = evaluateHealth(clean(), NOW);
    expect(r.status).toBe("ok");
    expect(r.issues).toEqual([]);
  });
  it("fails when maintenance never reported or stopped", () => {
    expect(evaluateHealth(clean({ maintenance: null }), NOW).status).toBe("fail");
    expect(
      evaluateHealth(clean({ maintenance: { last_run_at: ago(1), last_ok_at: null, last_error: "boom" } }), NOW).issues[0]!.detail,
    ).toContain("boom");
    expect(evaluateHealth(clean({ maintenance: { last_run_at: ago(5), last_ok_at: ago(45), last_error: "x" } }), NOW).status).toBe("fail");
    expect(evaluateHealth(clean({ maintenance: { last_run_at: ago(1), last_ok_at: ago(29), last_error: null } }), NOW).status).toBe("ok");
  });
  it("only warns when the latest run had a failed step but a good run is recent", () => {
    const r = evaluateHealth(clean({ maintenance: { last_run_at: ago(1), last_ok_at: ago(1), last_error: "emails" } }), NOW);
    expect(r.status).toBe("warn");
  });
  it("fails on money and booking problems", () => {
    for (const k of ["paid_inventory_lost", "payment_events_stuck", "refunds_stuck", "holds_overdue"] as const) {
      const r = evaluateHealth(clean({ [k]: 1 }), NOW);
      expect(r.status).toBe("fail");
      expect(r.issues.map((i) => i.check)).toEqual([k]);
    }
  });
  it("warns on softer signals", () => {
    for (const over of [{ emails_stuck: 1 }, { emails_failed_7d: 5 }, { payment_events_mismatch_7d: 1 }, { attention_other: 2 }]) {
      expect(evaluateHealth(clean(over), NOW).status).toBe("warn");
    }
    expect(evaluateHealth(clean({ emails_failed_7d: 4 }), NOW).status).toBe("ok");
  });
  it("a fail outranks warnings", () => {
    expect(evaluateHealth(clean({ emails_stuck: 3, refunds_stuck: 1 }), NOW).status).toBe("fail");
  });
  it("answers 503 only for fail", () => {
    expect([httpStatusFor("ok"), httpStatusFor("warn"), httpStatusFor("fail")]).toEqual([200, 200, 503]);
  });
});
