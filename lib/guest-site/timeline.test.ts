import { describe, expect, it } from "vitest";
import { bookingTimeline } from "./timeline";

const states = (status: string) => bookingTimeline(status).map((s) => `${s.key}:${s.state}`);

describe("bookingTimeline", () => {
  it("shows a held booking at the first step", () => {
    expect(states("pending")).toEqual(["held:current", "confirmed:later", "checked_in:later", "checked_out:later"]);
  });
  it("marks earlier steps done as the stay moves on", () => {
    expect(states("confirmed")).toEqual(["held:done", "confirmed:current", "checked_in:later", "checked_out:later"]);
    expect(states("checked_in")).toEqual(["held:done", "confirmed:done", "checked_in:current", "checked_out:later"]);
    expect(states("checked_out")).toEqual(["held:done", "confirmed:done", "checked_in:done", "checked_out:current"]);
  });
  it("ends a booking that never became a stay in one closing step", () => {
    expect(states("cancelled")).toEqual(["held:done", "cancelled:current"]);
    expect(bookingTimeline("expired").at(-1)?.label).toBe("Expired");
    expect(bookingTimeline("no_show").at(-1)?.label).toBe("No-show");
  });
  it("treats an unknown status as nothing reached", () => {
    expect(states("mystery").every((s) => s.endsWith(":later"))).toBe(true);
  });
});
