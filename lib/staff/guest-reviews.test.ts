import { describe, expect, it } from "vitest";
import { parseDecision, pendingCount, sortReviews } from "./guest-reviews";

describe("guest reviews (staff)", () => {
  const rows = [
    { status: "approved", created_at: "2026-11-03" },
    { status: "rejected", created_at: "2026-11-09" },
    { status: "pending", created_at: "2026-11-01" },
    { status: "pending", created_at: "2026-11-05" },
    { status: "approved", created_at: "2026-11-07" },
  ];
  it("puts pending first, then approved, then rejected, newest first inside each", () => {
    expect(sortReviews(rows).map((r) => `${r.status}:${r.created_at}`)).toEqual([
      "pending:2026-11-05",
      "pending:2026-11-01",
      "approved:2026-11-07",
      "approved:2026-11-03",
      "rejected:2026-11-09",
    ]);
  });
  it("does not change the list it is given", () => {
    const copy = rows.map((r) => ({ ...r }));
    sortReviews(rows);
    expect(rows).toEqual(copy);
  });
  it("counts pending", () => {
    expect(pendingCount(rows)).toBe(2);
    expect(pendingCount([])).toBe(0);
  });
  it("accepts only approve or reject", () => {
    expect(parseDecision("approved")).toBe("approved");
    expect(parseDecision("rejected")).toBe("rejected");
    for (const bad of ["pending", "", null, undefined, 1, "APPROVED"]) expect(parseDecision(bad)).toBeNull();
  });
});
