import { describe, expect, it } from "vitest";
import { statusEventLine } from "./room-status-history";

describe("statusEventLine", () => {
  it("names a housekeeping change, who made it and when, in the hotel's time", () => {
    expect(
      statusEventLine(
        {
          changed_at: "2026-11-03T13:05:00Z",
          field: "housekeeping_status",
          from_value: "dirty",
          to_value: "in_progress",
          actor_name: "Grace Eze",
        },
        "Africa/Lagos",
      ),
    ).toEqual({ title: "Housekeeping: Dirty to Being cleaned", detail: "Grace Eze · 3 Nov, 14:05" });
  });
  it("names an operational change, and a change made by no one as the system", () => {
    expect(
      statusEventLine(
        {
          changed_at: "2026-11-03T13:05:00Z",
          field: "operational_status",
          from_value: "active",
          to_value: "out_of_service",
          actor_name: null,
        },
        "UTC",
      ),
    ).toEqual({ title: "Room: In service to Out of service", detail: "the system · 3 Nov, 13:05" });
  });
  it("copes with an unknown value and a missing old one", () => {
    expect(
      statusEventLine(
        { changed_at: "2026-11-03T13:05:00Z", field: "housekeeping_status", from_value: null, to_value: "deep_clean", actor_name: "A" },
        "UTC",
      ).title,
    ).toBe("Housekeeping: Not set to deep clean");
  });
});
