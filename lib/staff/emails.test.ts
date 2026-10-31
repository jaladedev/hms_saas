import { describe, expect, it } from "vitest";
import { canOfferResend, errorAdvice, holdEnded, kindLabel, splitEmails, type FailedEmail } from "./emails";
import { classifyRpcError, errorMessage } from "./refunds";

function email(over: Partial<FailedEmail> = {}): FailedEmail {
  return {
    id: "e1", kind: "booking_confirmed", to_email: "a@example.com", attempts: 5, last_error: "provider said no",
    created_at: "2026-10-31T09:00:00Z", updated_at: "2026-10-31T10:00:00Z", next_attempt_at: "2026-10-31T10:00:00Z",
    reservation_id: "r1", property_id: "p1", booking_reference: "BK-1", reservation_status: "confirmed", state: "failed", ...over,
  };
}

describe("canOfferResend", () => {
  it("offers resend only for failed emails the person may resend", () => {
    expect(canOfferResend(email(), true)).toBe(true);
    expect(canOfferResend(email(), false)).toBe(false);
    expect(canOfferResend(email({ state: "retrying", attempts: 2 }), true)).toBe(false);
  });
  it("withholds a held-room email once the hold has ended", () => {
    const held = email({ kind: "booking_held", reservation_status: "pending" });
    expect(canOfferResend(held, true)).toBe(true);
    for (const s of ["expired", "confirmed", "cancelled"]) {
      expect(holdEnded({ ...held, reservation_status: s })).toBe(true);
      expect(canOfferResend({ ...held, reservation_status: s }, true)).toBe(false);
    }
    expect(holdEnded(email({ kind: "booking_confirmed", reservation_status: "cancelled" }))).toBe(false);
  });
});

describe("errorAdvice and labels", () => {
  it("explains the missing-domain failure and leaves other errors alone", () => {
    expect(errorAdvice("no verified domain for this hotel")).toMatch(/Verify a domain/);
    expect(errorAdvice("provider said no")).toBeNull();
    expect(errorAdvice(null)).toBeNull();
  });
  it("labels every email kind and tolerates new ones", () => {
    expect(kindLabel("booking_cancelled")).toBe("Booking cancelled");
    expect(kindLabel("some_new_kind")).toBe("some new kind");
  });
  it("splits failed from retrying", () => {
    const s = splitEmails([email({ id: "a" }), email({ id: "b", state: "retrying" })]);
    expect(s.failed.map((e) => e.id)).toEqual(["a"]);
    expect(s.retrying.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("resend errors", () => {
  it("maps the database's refusals to plain sentences", () => {
    expect(classifyRpcError("POLICY_VIOLATION: hold is no longer active").code).toBe("hold_inactive");
    expect(errorMessage("hold_inactive", null, String)).toMatch(/no longer on hold/);
    expect(classifyRpcError("INVALID_STATE: sent").code).toBe("invalid_state");
  });
});
