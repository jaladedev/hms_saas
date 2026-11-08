import { describe, expect, it } from "vitest";
import { answerText, describeRequest, notAllowedChangeText, parseChangeRequest, parsePhone } from "./change";
import { friendlyError } from "./errors";

const fmt = (d: string) => `<${d}>`;

describe("parseChangeRequest", () => {
  it("reads a dates request and ignores the message being empty", () => {
    expect(parseChangeRequest({ kind: "dates", arrival: "2026-12-01", departure: "2026-12-04", message: "  " }))
      .toEqual({ kind: "dates", arrival: "2026-12-01", departure: "2026-12-04", message: null });
  });
  it("refuses dates that are missing, malformed, equal or backwards", () => {
    for (const [a, d] of [["", ""], ["2026-12-01", "2026-12-01"], ["2026-12-05", "2026-12-01"], ["01/12/2026", "2026-12-03"], ["2026-13-45", "2026-12-03"]])
      expect(parseChangeRequest({ kind: "dates", arrival: a, departure: d })).toBeNull();
  });
  it("needs a message for a room or other request and drops any dates", () => {
    expect(parseChangeRequest({ kind: "room", arrival: "2026-12-01", departure: "2026-12-04", message: "quiet floor" }))
      .toEqual({ kind: "room", arrival: null, departure: null, message: "quiet floor" });
    expect(parseChangeRequest({ kind: "other", message: "   " })).toBeNull();
    expect(parseChangeRequest({ kind: "other" })).toBeNull();
  });
  it("refuses unknown kinds and messages over 500 characters", () => {
    expect(parseChangeRequest({ kind: "refund", message: "x" })).toBeNull();
    expect(parseChangeRequest({ kind: "other", message: "x".repeat(501) })).toBeNull();
    expect(parseChangeRequest({ kind: "other", message: "x".repeat(500) })).not.toBeNull();
  });
});

describe("parsePhone", () => {
  it("accepts the shapes the database accepts and nothing else", () => {
    expect(parsePhone(" +234 801-234 5678 ")).toBe("+234 801-234 5678");
    expect(parsePhone("(0801) 234.5678")).toBe("(0801) 234.5678");
    for (const bad of ["", "12345", "call me", "+234 801 <b>", "1".repeat(31), 42, null, undefined]) expect(parsePhone(bad), String(bad)).toBeNull();
  });
});

describe("wording", () => {
  it("says why a booking cannot be changed", () => {
    expect(notAllowedChangeText("disabled")).toMatch(/does not take booking changes online/);
    expect(notAllowedChangeText("started")).toMatch(/stay has started/);
    expect(notAllowedChangeText("status", "cancelled")).toMatch(/was cancelled/);
    expect(notAllowedChangeText("status", "pending")).toMatch(/Only a confirmed booking/);
    expect(notAllowedChangeText(null)).toBe("");
  });
  it("describes an open request and the last answer", () => {
    const base = { id: "1", created_at: "", message: null };
    expect(describeRequest({ ...base, kind: "dates", arrival: "2026-12-01", departure: "2026-12-03" }, fmt)).toBe("New dates: <2026-12-01> to <2026-12-03>.");
    expect(describeRequest({ ...base, kind: "room", arrival: null, departure: null }, fmt)).toBe("A different room.");
    expect(describeRequest({ ...base, kind: "other", arrival: null, departure: null }, fmt)).toBe("A message to the hotel.");
    expect(answerText({ status: "declined", note: "Full that night.", resolved_at: "" })).toBe("The hotel could not do your last request. They said: Full that night.");
    expect(answerText({ status: "done", note: null, resolved_at: "" })).toMatch(/dealt with your last request/);
  });
  it("maps the database refusals to guest messages that do not mention cancelling", () => {
    expect(friendlyError("INVALID_STATE: change disabled").code).toBe("change_disabled");
    expect(friendlyError("INVALID_STATE: change status").code).toBe("change_not_allowed");
    expect(friendlyError("INVALID_STATE: change started").code).toBe("change_not_allowed");
    expect(friendlyError("INVALID_STATE: change window").code).toBe("change_window");
    expect(friendlyError("INVALID_STATE: change open request").code).toBe("change_open");
    expect(friendlyError("POLICY_VIOLATION: phone").code).toBe("change_phone");
    expect(friendlyError("POLICY_VIOLATION: dates").code).toBe("change_dates");
    expect(friendlyError("POLICY_VIOLATION: request").code).toBe("change_request");
    for (const c of ["change_disabled", "change_window", "change_open"]) expect(friendlyError(`INVALID_STATE: ${c.replace("change_", "change ").replace("open", "open request")}`).message).not.toMatch(/cancel/i);
  });
});

import { datesRefusalText, datesSummary } from "./change";

describe("changing dates alone", () => {
  const money = (m: number) => `N${m / 100}`;
  it("says the price effect before the guest confirms", () => {
    expect(datesSummary({ old_total_minor: 30000, new_total_minor: 30000, difference_minor: 0 }, money)).toBe("The price stays N300.");
    expect(datesSummary({ old_total_minor: 30000, new_total_minor: 20000, difference_minor: -10000 }, money)).toBe("The price goes from N300 down to N200, N100 less.");
    expect(datesSummary({ old_total_minor: 30000, new_total_minor: null, difference_minor: null }, money)).toBe("");
  });
  it("explains every refusal and points to a request where the hotel can help", () => {
    for (const why of ["window", "dates", "same", "dearer", "overpaid", "discount", "extras", "busy", "no_rate", "disabled", "status", "started", null, "anything"])
      expect(datesRefusalText(why as string | null).length, String(why)).toBeGreaterThan(10);
    expect(datesRefusalText("dearer")).toMatch(/request/);
    expect(datesRefusalText("overpaid")).toMatch(/request/);
  });
  it("words the database refusals for the guest", () => {
    expect(friendlyError("INVALID_STATE: dates dearer").code).toBe("dates_not_self_serve");
    expect(friendlyError("POLICY_VIOLATION: total changed").code).toBe("dates_total_changed");
    expect(friendlyError("ROOM_UNAVAILABLE").code).toBe("unavailable");
    expect(friendlyError("RATE_MISSING").code).toBe("dates_no_rate");
  });
});
