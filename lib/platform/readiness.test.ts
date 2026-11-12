import { describe, expect, it } from "vitest";
import { groupChecks, propertyChecks, readReadiness, summarize } from "./readiness";

const ready = {
  tenant_status: "active",
  online_booking: true,
  online_payments: true,
  active_payment_accounts: 1,
  domains: 2,
  domains_verified: 1,
  properties: [
    {
      id: "p1",
      name: "Main",
      status: "active",
      room_types: 2,
      rooms: 12,
      default_rate_plan: true,
      tax_rules: 1,
      policy_versions: 1,
      domains_verified: 1,
    },
  ],
};

describe("readReadiness", () => {
  it("reads a good answer and treats anything malformed as not ready", () => {
    expect(readReadiness(ready)?.properties[0]?.rooms).toBe(12);
    for (const bad of [null, undefined, 5, "x"]) expect(readReadiness(bad)).toBeNull();
    const r = readReadiness({ properties: [null, { id: 3, rooms: -4, room_types: "x" }], domains: NaN });
    expect(r?.domains).toBe(0);
    expect(r?.properties[1]).toMatchObject({ id: "", rooms: 0, room_types: 0, default_rate_plan: false });
    expect(r?.tenant_status).toBe("");
  });
  it("a missing flag counts as on, only an explicit false as off", () => {
    expect(readReadiness({})?.online_booking).toBe(true);
    expect(readReadiness({ online_booking: false })?.online_booking).toBe(false);
  });
});

describe("summarize", () => {
  it("has no failing blocker for a hotel that can take a booking", () => {
    const s = summarize(readReadiness(ready)!);
    expect(s.blockers).toBe(0);
    expect(s.properties[0]?.checks.every((c) => c.ok)).toBe(true);
  });
  it("counts each failing blocker, and advice never counts", () => {
    const r = readReadiness({
      ...ready,
      online_payments: false,
      active_payment_accounts: 0,
      properties: [{ ...ready.properties[0], tax_rules: 0, policy_versions: 0 }],
    })!;
    expect(summarize(r).blockers).toBe(0);
    const bad = readReadiness({
      ...ready,
      tenant_status: "suspended",
      online_booking: false,
      domains_verified: 0,
      properties: [{ ...ready.properties[0], status: "inactive", room_types: 0, rooms: 0, default_rate_plan: false }],
    })!;
    expect(summarize(bad).blockers).toBe(3 + 4);
  });
  it("explains each failure in words", () => {
    const g = groupChecks(readReadiness({ ...ready, domains_verified: 0 })!);
    expect(g.find((c) => c.key === "domain")?.detail).toMatch(/none verified/);
    expect(groupChecks(readReadiness({ ...ready, domains: 0, domains_verified: 0 })!).find((c) => c.key === "domain")?.detail).toMatch(
      /No website address/,
    );
    const p = propertyChecks({ ...ready.properties[0]!, default_rate_plan: false });
    expect(p.find((c) => c.key === "rate_plan")).toMatchObject({ ok: false, blocker: true });
  });
});
