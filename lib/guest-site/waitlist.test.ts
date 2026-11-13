import { describe, expect, it } from "vitest";
import { friendlyError, messageForCode } from "./errors";
import { parseWaitlistForm } from "./waitlist";

const good = {
  arrival: "2027-03-01",
  departure: "2027-03-03",
  adults: "2",
  children: "0",
  roomTypeId: "00000000-0000-0000-0000-0000000000a4",
  name: " Ada Obi ",
  email: " Ada@Example.com ",
  phone: "+234 801 234 5678",
};

describe("parseWaitlistForm", () => {
  it("reads a full form, trimming and lowercasing", () => {
    const r = parseWaitlistForm(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Ada Obi");
      expect(r.value.email).toBe("ada@example.com");
      expect(r.value.stay).toMatchObject({ arrival: "2027-03-01", adults: 2, children: 0 });
    }
  });
  it("allows a missing phone", () => {
    const r = parseWaitlistForm({ ...good, phone: "" });
    expect(r.ok && r.value.phone).toBe("");
  });
  it("rejects bad stay or room type as a bad request", () => {
    expect(parseWaitlistForm({ ...good, arrival: "nope" })).toEqual({ ok: false, error: "bad_request" });
    expect(parseWaitlistForm({ ...good, roomTypeId: "x" })).toEqual({ ok: false, error: "bad_request" });
    expect(parseWaitlistForm({ ...good, departure: "2027-03-01" })).toEqual({ ok: false, error: "bad_request" });
  });
  it("rejects bad contact details", () => {
    for (const patch of [{ name: "A" }, { email: "nope" }, { phone: "abc" }, { phone: "1".repeat(40) }, { name: 5 }]) {
      expect(parseWaitlistForm({ ...good, ...patch })).toEqual({ ok: false, error: "waitlist_details" });
    }
  });
});

describe("waitlist messages", () => {
  it("maps database refusals to guest wording", () => {
    expect(friendlyError("POLICY_VIOLATION: waitlist rooms free").code).toBe("waitlist_free");
    expect(friendlyError("POLICY_VIOLATION: waitlist too many requests").code).toBe("waitlist_many");
    expect(friendlyError("POLICY_VIOLATION: waitlist email").code).toBe("waitlist_details");
    expect(friendlyError("POLICY_VIOLATION: waitlist dates").code).toBe("dates");
    expect(messageForCode("waitlist_details")).toMatch(/phone/);
  });
});
