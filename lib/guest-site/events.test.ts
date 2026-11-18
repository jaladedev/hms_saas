import { describe, expect, it } from "vitest";
import { guestEventError, parseTicketOrder, parseVenueRequest } from "./events";

const V = "11111111-2222-4333-8444-555555555555";
const T1 = "aaaaaaaa-2222-4333-8444-555555555555";
const base = {
  venueId: V,
  startsAt: "2027-03-01T10:00",
  endsAt: "2027-03-01T16:00",
  eventType: "wedding",
  attendees: "80",
  name: "Ada",
  email: "ada@example.com",
  mode: "book",
};

describe("guestEventError", () => {
  it("words known refusals and hides the rest", () => {
    expect(guestEventError("VENUE_UNAVAILABLE").code).toBe("ev_unavailable");
    expect(guestEventError("SOLD_OUT").code).toBe("ev_sold_out");
    expect(guestEventError("POLICY_VIOLATION: too soon").code).toBe("ev_past");
    expect(guestEventError("POLICY_VIOLATION: too far").code).toBe("ev_when");
    expect(guestEventError("POLICY_VIOLATION: too many open").code).toBe("ev_limit");
    const other = guestEventError('relation "x" does not exist');
    expect(other.code).toBe("unknown");
    expect(other.message).not.toMatch(/relation/);
  });
});

describe("parseVenueRequest", () => {
  it("accepts a good form", () => {
    const p = parseVenueRequest(base);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.attendees).toBe(80);
  });
  it("refuses bad input", () => {
    expect(parseVenueRequest({ ...base, email: "nope" }).ok).toBe(false);
    expect(parseVenueRequest({ ...base, attendees: "0" }).ok).toBe(false);
    expect(parseVenueRequest({ ...base, endsAt: base.startsAt }).ok).toBe(false);
    expect(parseVenueRequest({ ...base, mode: "x" }).ok).toBe(false);
    expect(parseVenueRequest({ ...base, eventType: "rave" }).ok).toBe(false);
    expect(parseVenueRequest({ ...base, venueId: "x" }).ok).toBe(false);
  });
});

describe("parseTicketOrder", () => {
  const form = { eventId: V, name: "Ada", email: "ada@example.com", [`qty_${T1}`]: "2" };
  it("reads quantities", () => {
    const p = parseTicketOrder(form);
    expect(p.ok && p.value.items).toEqual([{ ticket_type_id: T1, quantity: 2 }]);
  });
  it("needs a ticket and a valid buyer", () => {
    expect(parseTicketOrder({ ...form, [`qty_${T1}`]: "0" }).ok).toBe(false);
    expect(parseTicketOrder({ ...form, email: "x" }).ok).toBe(false);
    expect(parseTicketOrder({ ...form, [`qty_${T1}`]: "abc" }).ok).toBe(false);
  });
});
