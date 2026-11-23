import { describe, expect, it } from "vitest";
import { WARM_EVERY_MS, bannerState, savedAtLabel, shouldWarm } from "./saved-pages";

describe("banner state", () => {
  it("says nothing when online with a live page", () => {
    expect(bannerState(false, null)).toBe("none");
  });
  it("tells a saved copy from a live page when offline", () => {
    expect(bannerState(true, "2026-11-23T10:42:00Z")).toBe("offline-saved");
    expect(bannerState(true, null)).toBe("offline-live");
  });
  it("flags a saved copy shown on a slow connection", () => {
    expect(bannerState(false, "2026-11-23T10:42:00Z")).toBe("slow-saved");
  });
});

describe("warm-up timing", () => {
  const now = 1_000_000_000_000;
  it("warms when never done, when due, or when the clock went backwards", () => {
    expect(shouldWarm(null, now)).toBe(true);
    expect(shouldWarm(now - WARM_EVERY_MS, now)).toBe(true);
    expect(shouldWarm(now + 5_000, now)).toBe(true);
    expect(shouldWarm(Number.NaN, now)).toBe(true);
  });
  it("waits when it ran recently", () => {
    expect(shouldWarm(now - WARM_EVERY_MS + 1, now)).toBe(false);
  });
});

describe("saved-at label", () => {
  it("shows only the time for today and the weekday for another day", () => {
    const now = new Date("2026-11-23T15:00:00");
    expect(savedAtLabel("2026-11-23T10:42:00", now)).toMatch(/10:42/);
    expect(savedAtLabel("2026-11-23T10:42:00", now)).not.toMatch(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/);
    expect(savedAtLabel("2026-11-22T10:42:00", now)).toMatch(/Sun/);
  });
  it("does not break on a bad stamp", () => {
    expect(savedAtLabel("nonsense", new Date())).toBe("earlier");
  });
});
