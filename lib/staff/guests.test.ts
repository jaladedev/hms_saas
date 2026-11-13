import { describe, expect, it } from "vitest";
import {
  bookedLine,
  checkGuestForm,
  checkGuestProfile,
  MAX_NOTES,
  searchPattern,
  stayLine,
  summariseStays,
  vipOnly,
  type StayRow,
} from "./guests";
import { classifyRpcError, errorMessage } from "./refunds";

describe("searchPattern", () => {
  it("wraps a cleaned term for a contains search", () => {
    expect(searchPattern("Ada")).toBe("*Ada*");
    expect(searchPattern("  ada@example.com ")).toBe("*ada@example.com*");
    expect(searchPattern("+234 800")).toBe("*+234 800*");
    expect(searchPattern("O'Brien-Smith")).toBe("*O'Brien-Smith*");
    expect(searchPattern("Adé Okafor")).toBe("*Adé Okafor*");
  });
  it("strips what could change the filter, and refuses too little", () => {
    expect(searchPattern("a,full_name.eq.x)")).toBe("*a full name.eq.x*");
    expect(searchPattern("100%_*\\")).toBe("*100*");
    expect(searchPattern("(),")).toBeNull();
    expect(searchPattern("a")).toBeNull();
    expect(searchPattern("")).toBeNull();
    expect(searchPattern(undefined)).toBeNull();
    expect(searchPattern("x".repeat(200))).toBe(`*${"x".repeat(60)}*`);
  });
});

describe("summariseStays and stayLine", () => {
  const r = (g: string, st: string, a: string, d: string): StayRow => ({
    primary_guest_id: g,
    reservation_status: st,
    arrival_date: a,
    departure_date: d,
  });
  const fmt = (d: string) => d;
  const m = summariseStays(
    [
      r("a", "checked_out", "2026-09-01", "2026-09-03"),
      r("a", "checked_out", "2026-10-01", "2026-10-04"),
      r("a", "confirmed", "2026-11-20", "2026-11-22"),
      r("a", "confirmed", "2026-11-05", "2026-11-06"),
      r("a", "confirmed", "2026-10-01", "2026-10-02"),
      r("a", "cancelled", "2026-12-01", "2026-12-03"),
      r("b", "checked_in", "2026-10-30", "2026-11-02"),
      r("c", "cancelled", "2026-09-01", "2026-09-03"),
      r("c", "expired", "2026-09-05", "2026-09-06"),
    ],
    "2026-10-31",
  );
  it("counts finished stays and finds the next arrival from today on", () => {
    expect(m.get("a")).toEqual({ completed: 2, nextArrival: "2026-11-05", lastDeparture: "2026-10-04", inHouse: false, booked: new Map() });
    expect(m.get("b")).toEqual({ completed: 0, nextArrival: null, lastDeparture: "2026-11-02", inHouse: true, booked: new Map() });
    expect(m.get("c")).toEqual({ completed: 0, nextArrival: null, lastDeparture: null, inHouse: false, booked: new Map() });
  });
  it("words one line per guest", () => {
    expect(stayLine(m.get("b"), fmt)).toBe("In house now");
    expect(stayLine(m.get("a"), fmt)).toBe("Arrives 2026-11-05");
    expect(stayLine({ completed: 1, nextArrival: null, lastDeparture: "2026-10-04", inHouse: false, booked: new Map() }, fmt)).toBe(
      "1 stay, last left 2026-10-04",
    );
    expect(stayLine({ completed: 3, nextArrival: null, lastDeparture: null, inHouse: false, booked: new Map() }, fmt)).toBe("3 stays");
    expect(stayLine(m.get("c"), fmt)).toBe("No stays yet");
    expect(stayLine(undefined, fmt)).toBe("No stays yet");
  });
});

describe("checkGuestForm and errors", () => {
  const ok = { full_name: "Ada Okafor", email: "ada@example.com", phone: "+2348000000001", address: "", country_code: "ng" };
  it("accepts good details and blanks", () => {
    expect(checkGuestForm(ok)).toBeNull();
    expect(checkGuestForm({ ...ok, email: "", phone: "", country_code: "" })).toBeNull();
  });
  it("names the first problem", () => {
    expect(checkGuestForm({ ...ok, full_name: "   " })).toBe("guest_name");
    expect(checkGuestForm({ ...ok, email: "nope" })).toBe("guest_email");
    expect(checkGuestForm({ ...ok, email: "a b@x.com" })).toBe("guest_email");
    expect(checkGuestForm({ ...ok, country_code: "NGA" })).toBe("guest_country");
    expect(checkGuestForm({ ...ok, phone: "9".repeat(41) })).toBe("guest_field");
  });
  it("maps the database's refusals", () => {
    for (const [msg, code] of [
      ["POLICY_VIOLATION: name", "guest_name"],
      ["POLICY_VIOLATION: email", "guest_email"],
      ["POLICY_VIOLATION: country", "guest_country"],
      ["POLICY_VIOLATION: too long", "guest_field"],
    ] as const) {
      expect(classifyRpcError(msg).code).toBe(code);
      expect(errorMessage(code, null, String)).not.toMatch(/Something went wrong/);
    }
  });
});

describe("booked total on completed stays", () => {
  const stay = (over: Partial<StayRow>): StayRow => ({
    primary_guest_id: "g",
    reservation_status: "checked_out",
    arrival_date: "2026-09-01",
    departure_date: "2026-09-03",
    total_minor: 100_000,
    currency: "NGN",
    ...over,
  });
  const money = (minor: number, cur: string) => `${cur} ${(minor / 100).toLocaleString("en-US")}`;
  it("adds up only checked-out stays, per currency", () => {
    const m = summariseStays(
      [
        stay({}),
        stay({ total_minor: 50_000 }),
        stay({ reservation_status: "cancelled", total_minor: 999_999 }),
        stay({ reservation_status: "confirmed", arrival_date: "2026-12-01", total_minor: 888_888 }),
        stay({ reservation_status: "checked_in", total_minor: 777_777 }),
        stay({ currency: "USD", total_minor: 20_000 }),
      ],
      "2026-11-10",
    );
    expect(m.get("g")?.booked).toEqual(
      new Map([
        ["NGN", 150_000],
        ["USD", 20_000],
      ]),
    );
    expect(bookedLine(m.get("g"), money)).toBe("NGN 1,500 and USD 200 booked");
  });
  it("shows nothing when there is nothing to show or the rows carry no amounts", () => {
    expect(bookedLine(undefined, money)).toBeNull();
    expect(
      bookedLine(summariseStays([stay({ reservation_status: "confirmed", arrival_date: "2026-12-01" })], "2026-11-10").get("g"), money),
    ).toBeNull();
    const noAmounts = summariseStays(
      [{ primary_guest_id: "g", reservation_status: "checked_out", arrival_date: "2026-09-01", departure_date: "2026-09-03" }],
      "2026-11-10",
    );
    expect(noAmounts.get("g")?.completed).toBe(1);
    expect(bookedLine(noAmounts.get("g"), money)).toBeNull();
  });
  it("ignores an amount that is not a whole number and a zero total", () => {
    const m = summariseStays([stay({ total_minor: 12.5 }), stay({ total_minor: 0 })], "2026-11-10");
    expect(bookedLine(m.get("g"), money)).toBeNull();
  });
});

describe("VIP filter and notes", () => {
  it("turns the filter on only for the exact value 1", () => {
    expect(vipOnly("1")).toBe(true);
    expect(vipOnly(["1", "0"])).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", "11", ["0", "1"]]) expect(vipOnly(v)).toBe(false);
  });
  it("accepts notes up to the limit counted after trimming, and refuses more", () => {
    expect(checkGuestProfile({ notes: "" })).toBeNull();
    expect(checkGuestProfile({ notes: "x".repeat(MAX_NOTES) })).toBeNull();
    expect(checkGuestProfile({ notes: `  ${"x".repeat(MAX_NOTES)}  ` })).toBeNull();
    expect(checkGuestProfile({ notes: "x".repeat(MAX_NOTES + 1) })).toBe("guest_notes");
  });
});
