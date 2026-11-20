import { describe, expect, it } from "vitest";
import { classifyApiError, parseEndpointForm, parseKeyForm, parseRevokeForm } from "./api-access";

const P = "00000000-0000-0000-0000-0000000000a2";
const form = (entries: [string, string][]) => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};

describe("error words", () => {
  it("maps database refusals", () => {
    expect(classifyApiError("NOT_FOUND")).toBe("api_forbidden");
    expect(classifyApiError("POLICY_VIOLATION: api off")).toBe("api_off");
    expect(classifyApiError("POLICY_VIOLATION: too many")).toBe("api_too_many");
    expect(classifyApiError("POLICY_VIOLATION: url")).toBe("api_invalid");
    expect(classifyApiError("boom")).toBe("api_failed");
  });
});

describe("key form", () => {
  it("collects several scopes and a limit", () => {
    expect(
      parseKeyForm(
        form([
          ["propertyId", P],
          ["name", "Widget"],
          ["scope", "availability.read"],
          ["scope", "bookings.read"],
          ["limit", "120"],
        ]),
      ),
    ).toMatchObject({
      ok: true,
      value: { scopes: ["availability.read", "bookings.read"], limit: 120 },
    });
  });
  it("refuses no scope, an unknown scope, guests without bookings, and a bad limit", () => {
    const base: [string, string][] = [
      ["propertyId", P],
      ["name", "Widget"],
    ];
    expect(parseKeyForm(form(base)).ok).toBe(false);
    expect(parseKeyForm(form([...base, ["scope", "bookings.write"]])).ok).toBe(false);
    expect(parseKeyForm(form([...base, ["scope", "guests.read"]])).ok).toBe(false);
    expect(parseKeyForm(form([...base, ["scope", "bookings.read"], ["limit", "0"]])).ok).toBe(false);
    expect(parseKeyForm(form([...base, ["scope", "bookings.read"], ["limit", "601"]])).ok).toBe(false);
    expect(
      parseKeyForm(
        form([
          ["propertyId", P],
          ["name", ""],
          ["scope", "bookings.read"],
        ]),
      ).ok,
    ).toBe(false);
  });
});

describe("endpoint form", () => {
  const base: [string, string][] = [
    ["propertyId", P],
    ["url", "https://example.com/h"],
    ["event", "booking.created"],
  ];
  it("takes https and known events", () => {
    expect(parseEndpointForm(form([...base, ["event", "booking.cancelled"], ["active", "on"]]))).toMatchObject({
      ok: true,
      value: { active: true, endpointId: null, events: ["booking.created", "booking.cancelled"] },
    });
  });
  it("refuses http, spaces, unknown events and no events", () => {
    expect(
      parseEndpointForm(
        form([
          ["propertyId", P],
          ["url", "http://example.com/h"],
          ["event", "booking.created"],
        ]),
      ).ok,
    ).toBe(false);
    expect(
      parseEndpointForm(
        form([
          ["propertyId", P],
          ["url", "https://exa mple.com"],
          ["event", "booking.created"],
        ]),
      ).ok,
    ).toBe(false);
    expect(
      parseEndpointForm(
        form([
          ["propertyId", P],
          ["url", "https://example.com/h"],
          ["event", "booking.exploded"],
        ]),
      ).ok,
    ).toBe(false);
    expect(
      parseEndpointForm(
        form([
          ["propertyId", P],
          ["url", "https://example.com/h"],
        ]),
      ).ok,
    ).toBe(false);
  });
});

describe("revoke form", () => {
  it("needs a real id", () => {
    expect(parseRevokeForm(form([["keyId", P]])).ok).toBe(true);
    expect(parseRevokeForm(form([["keyId", "x"]])).ok).toBe(false);
  });
});
