import { describe, expect, it } from "vitest";
import { classifyGuestLinkError, guestLinkResultCode, parseGuestLinkReason } from "./guest-link";

describe("guest link reset", () => {
  it("needs a reason of 1 to 200 characters", () => {
    expect(parseGuestLinkReason("  sent to the wrong person ")).toEqual({ ok: true, reason: "sent to the wrong person" });
    for (const bad of ["", "   ", "x".repeat(201), undefined, null, 5])
      expect(parseGuestLinkReason(bad), String(bad)).toEqual({ ok: false, code: "gl_reason" });
    expect(parseGuestLinkReason("x".repeat(200)).ok).toBe(true);
  });
  it("words refusals", () => {
    expect(classifyGuestLinkError("POLICY_VIOLATION: reason")).toBe("gl_reason");
    expect(classifyGuestLinkError("NOT_FOUND")).toBe("not_found");
    expect(classifyGuestLinkError("IDEMPOTENCY_MISMATCH")).toBe("se_duplicate");
    expect(classifyGuestLinkError("boom")).toBe("unknown");
  });
  it("says whether an email went out", () => {
    expect(guestLinkResultCode({ email_queued: true })).toBe("guest_links_reset");
    expect(guestLinkResultCode({ email_queued: false })).toBe("guest_links_reset_no_email");
    expect(guestLinkResultCode(null)).toBe("guest_links_reset");
  });
});
