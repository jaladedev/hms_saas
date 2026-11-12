import { describe, expect, it } from "vitest";
import { readWindows, stateLabel, viewsLabel } from "./platform-access";

const ok = {
  id: "a",
  approved_at: "2026-11-12T10:00:00Z",
  hours: 4,
  until: "2026-11-12T14:00:00Z",
  ended_at: null,
  state: "open",
  views: 2,
  last_viewed_at: "2026-11-12T10:30:00Z",
};

describe("platform access windows", () => {
  it("reads good rows and drops bad ones", () => {
    expect(
      readWindows([ok, null, "x", { ...ok, state: "weird" }, { ...ok, id: 3 }, { ...ok, id: "b", views: -4, last_viewed_at: 5 }]),
    ).toEqual([ok, { ...ok, id: "b", views: 0, last_viewed_at: null }]);
  });
  it("is empty for anything that is not a list", () => {
    expect(readWindows(null)).toEqual([]);
    expect(readWindows({})).toEqual([]);
  });
  it("labels views and states", () => {
    expect(viewsLabel(0)).toBe("Never opened");
    expect(viewsLabel(1)).toBe("Opened once");
    expect(viewsLabel(3)).toBe("Opened 3 times");
    expect(stateLabel("open")).toBe("Open now");
    expect(stateLabel("ended_early")).toBe("Ended early");
    expect(stateLabel("finished")).toBe("Finished");
  });
});
