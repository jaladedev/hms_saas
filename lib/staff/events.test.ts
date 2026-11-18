import { describe, expect, it } from "vitest";
import {
  checkInProblem,
  classifyEventError,
  parseEventForm,
  parseQuoteLines,
  parseSellForm,
  parseTermsForm,
  parseTicketTypeForm,
  parseVenueForm,
} from "./events";

const P = "11111111-2222-4333-8444-555555555555";
const T = "aaaaaaaa-2222-4333-8444-555555555555";

describe("classifyEventError", () => {
  it("maps database refusals", () => {
    expect(classifyEventError("VENUE_UNAVAILABLE")).toBe("ev_unavailable");
    expect(classifyEventError("SOLD_OUT")).toBe("ev_sold_out");
    expect(classifyEventError("PAYMENT_REQUIRED deposit")).toBe("ev_deposit");
    expect(classifyEventError("INVALID_STATE: no lines")).toBe("ev_no_lines");
    expect(classifyEventError("something else")).toBeNull();
  });
});

describe("parseVenueForm", () => {
  const ok = { propertyId: P, venueId: "", name: "Grand Hall", capacity: "200", hourly: "50,000", day: "", online: "on", active: "on" };
  it("reads naira to kobo and needs a price", () => {
    const r = parseVenueForm(ok);
    expect(r.ok && r.value.hourlyMinor).toBe(5_000_000);
    expect(r.ok && r.value.dayMinor).toBeNull();
    expect(parseVenueForm({ ...ok, hourly: "" }).ok).toBe(false);
    expect(parseVenueForm({ ...ok, capacity: "0" }).ok).toBe(false);
  });
});

describe("parseTermsForm", () => {
  it("bounds the percentages and hold", () => {
    expect(parseTermsForm({ propertyId: P, tax: "7.5", service: "10", deposit: "30", holdHours: "48" }).ok).toBe(true);
    expect(parseTermsForm({ propertyId: P, tax: "101", service: "0", deposit: "30", holdHours: "48" }).ok).toBe(false);
    expect(parseTermsForm({ propertyId: P, tax: "0", service: "0", deposit: "30", holdHours: "0" }).ok).toBe(false);
  });
});

describe("parseQuoteLines", () => {
  it("skips empty rows and needs one line", () => {
    const r = parseQuoteLines({ kind_0: "venue", desc_0: "Hall", qty_0: "1", price_0: "100000", desc_1: "", price_1: "" });
    expect(r.ok && r.value).toEqual([{ kind: "venue", description: "Hall", quantity: 1, unit_amount_minor: 10_000_000 }]);
    expect(parseQuoteLines({}).ok).toBe(false);
    expect(parseQuoteLines({ kind_0: "x", desc_0: "Hall", price_0: "1" }).ok).toBe(false);
  });
});

describe("parseEventForm and parseTicketTypeForm", () => {
  it("needs the end after the start", () => {
    const base = { propertyId: P, eventId: "", title: "Gala", startsAt: "2027-03-01T18:00", endsAt: "2027-03-01T23:00", maxPerOrder: "10" };
    expect(parseEventForm(base).ok).toBe(true);
    expect(parseEventForm({ ...base, endsAt: base.startsAt }).ok).toBe(false);
    expect(parseTicketTypeForm({ eventId: P, name: "VIP", price: "", quantity: "50" }).ok).toBe(true);
    expect(parseTicketTypeForm({ eventId: P, name: "VIP", price: "x", quantity: "50" }).ok).toBe(false);
  });
});

describe("parseSellForm and checkInProblem", () => {
  it("reads quantities per ticket type", () => {
    const f = { propertyId: P, eventId: P, name: "Ada", phone: "0803", method: "cash", [`qty_${T}`]: "3" };
    const r = parseSellForm(f);
    expect(r.ok && r.value.items).toEqual([{ ticket_type_id: T, quantity: 3 }]);
    expect(parseSellForm({ ...f, [`qty_${T}`]: "0" }).ok).toBe(false);
    expect(parseSellForm({ ...f, method: "bitcoin" }).ok).toBe(false);
  });
  it("words the door's problems", () => {
    expect(checkInProblem("NOT_FOUND: ticket")).toBe("unknown");
    expect(checkInProblem("INVALID_STATE: used")).toBe("used");
    expect(checkInProblem("INVALID_STATE: wrong event")).toBe("wrong_event");
    expect(checkInProblem("NOT_FOUND")).toBe("forbidden");
  });
});
