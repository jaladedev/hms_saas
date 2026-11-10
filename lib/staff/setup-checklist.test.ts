import { describe, expect, it } from "vitest";
import { buildChecklist, countsFor, progressOf, type SetupCounts } from "./setup-checklist";

const empty: SetupCounts = { roomTypes: 0, rooms: 0, hasDefaultRatePlan: false, taxRules: 0, policyVersions: 0 };

describe("buildChecklist and progressOf", () => {
  it("starts with nothing done and points at the first required step", () => {
    const p = progressOf(buildChecklist(empty));
    expect(p).toMatchObject({ done: 0, total: 5, ready: false, complete: false });
    expect(p.next?.key).toBe("room_types");
  });
  it("is ready to take bookings once the three required steps are done, and then suggests the recommended ones", () => {
    const p = progressOf(buildChecklist({ ...empty, roomTypes: 1, rooms: 4, hasDefaultRatePlan: true }));
    expect(p).toMatchObject({ done: 3, ready: true, complete: false });
    expect(p.next?.key).toBe("tax");
  });
  it("is not ready while a required step is missing, even if the recommended ones are done", () => {
    const p = progressOf(buildChecklist({ ...empty, roomTypes: 1, rooms: 4, taxRules: 1, policyVersions: 1 }));
    expect(p.ready).toBe(false);
    expect(p.next?.key).toBe("rates");
  });
  it("is complete when everything is done and has no next step", () => {
    const p = progressOf(buildChecklist({ roomTypes: 2, rooms: 9, hasDefaultRatePlan: true, taxRules: 2, policyVersions: 1 }));
    expect(p).toMatchObject({ done: 5, complete: true, ready: true, next: null });
  });
  it("links every step to a settings screen", () => {
    expect(buildChecklist(empty).map((s) => s.href)).toEqual([
      "/app/settings/rooms",
      "/app/settings/rooms",
      "/app/settings/rates",
      "/app/settings/tax",
      "/app/settings/policies",
    ]);
  });
});

describe("countsFor", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  it("counts only this property, switched-on room types, rooms that are not retired and an active default plan", () => {
    const c = countsFor(A, {
      roomTypes: [
        { property_id: A, status: "active" },
        { property_id: A, status: "inactive" },
        { property_id: B, status: "active" },
      ],
      rooms: [
        { property_id: A, operational_status: "active" },
        { property_id: A, operational_status: "out_of_service" },
        { property_id: A, operational_status: "retired" },
        { property_id: B, operational_status: "active" },
      ],
      ratePlans: [
        { property_id: A, is_default: true, status: "inactive" },
        { property_id: B, is_default: true, status: "active" },
      ],
      taxRules: [{ property_id: A }, { property_id: B }],
      policies: [{ property_id: B }],
    });
    expect(c).toEqual({ roomTypes: 1, rooms: 2, hasDefaultRatePlan: false, taxRules: 1, policyVersions: 0 });
  });
});
