import { describe, expect, it } from "vitest";
import {
  classifyNightAuditError,
  figuresChanged,
  isDay,
  openItemsLabel,
  parseDay,
  parseDays,
  parseFigures,
  parseItems,
  parsePreview,
  NIGHT_AUDIT_ERROR_MESSAGES,
} from "./night-audit";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";

const figures = (o: Record<string, unknown> = {}) => ({
  day: "2026-11-18",
  rooms_available: 12,
  rooms_sold: 5,
  room_revenue_minor: 5_000_000,
  room_tax_minor: 375_000,
  room_service_minor: 0,
  extras_minor: 100_000,
  extras_tax_minor: 7_500,
  cash_in_minor: 2_000_000,
  refunds_paid_minor: 0,
  ...o,
});

const items = (o: Record<string, unknown> = {}) => ({
  arrivals_not_checked_in: 1,
  arrivals: [{ reservation_id: "r1", booking_reference: "HA-1" }],
  departures_not_checked_out: 0,
  departures: [],
  unverified_payments: 1,
  unverified_payments_minor: 10_000,
  payments: [{ reservation_id: "r1", booking_reference: "HA-1", amount_minor: 10_000 }],
  total: 2,
  ...o,
});

describe("isDay and parseDay", () => {
  it("accepts only real calendar days", () => {
    expect(isDay("2026-11-18")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-11-18T00:00")).toBe(false);
    expect(isDay("18/11/2026")).toBe(false);
    expect(isDay(undefined)).toBe(false);
  });
  it("uses the day asked for when it is today or earlier, otherwise today", () => {
    expect(parseDay("2026-11-10", "2026-11-18")).toBe("2026-11-10");
    expect(parseDay("2026-11-18", "2026-11-18")).toBe("2026-11-18");
    expect(parseDay("2026-11-19", "2026-11-18")).toBe("2026-11-18");
    expect(parseDay("nonsense", "2026-11-18")).toBe("2026-11-18");
    expect(parseDay(undefined, "2026-11-18")).toBe("2026-11-18");
  });
});

describe("parseFigures and figuresChanged", () => {
  it("reads the report row and ignores the room count", () => {
    const f = parseFigures(figures());
    expect(f?.rooms_sold).toBe(5);
    expect(f?.cash_in_minor).toBe(2_000_000);
    expect(f && "rooms_available" in f).toBe(false);
  });
  it("gives zero for a missing figure and null for a non-object", () => {
    expect(parseFigures({})?.room_revenue_minor).toBe(0);
    expect(parseFigures(null)).toBeNull();
    expect(parseFigures([1])).toBeNull();
  });
  it("sees a change in what was sold, earned or received, but not in the room count", () => {
    const kept = parseFigures(figures())!;
    expect(figuresChanged(kept, parseFigures(figures({ rooms_available: 3 }))!)).toBe(false);
    expect(figuresChanged(kept, parseFigures(figures({ extras_minor: 120_000 }))!)).toBe(true);
    expect(figuresChanged(kept, parseFigures(figures({ cash_in_minor: 1 }))!)).toBe(true);
    expect(figuresChanged(kept, parseFigures(figures({ rooms_sold: 6 }))!)).toBe(true);
    expect(figuresChanged(kept, parseFigures(figures({ refunds_paid_minor: 1 }))!)).toBe(true);
  });
});

describe("parseItems", () => {
  it("reads the counts and the lists", () => {
    const i = parseItems(items())!;
    expect(i.total).toBe(2);
    expect(i.arrivals).toEqual([{ reservation_id: "r1", booking_reference: "HA-1" }]);
    expect(i.payments[0]?.amount_minor).toBe(10_000);
  });
  it("drops list rows that are not well formed", () => {
    const i = parseItems(items({ arrivals: [{ reservation_id: "r1" }, null, { reservation_id: "r2", booking_reference: "HA-2" }] }))!;
    expect(i.arrivals.map((a) => a.booking_reference)).toEqual(["HA-2"]);
  });
  it("is null for a non-object", () => {
    expect(parseItems("x")).toBeNull();
  });
});

describe("parsePreview", () => {
  const good = { day: "2026-11-18", today: "2026-11-18", closed: false, items: items(), figures: figures(), kept_figures: null };
  it("reads an open day", () => {
    const p = parsePreview(good)!;
    expect(p.closed).toBe(false);
    expect(p.kept_figures).toBeNull();
    expect(p.items.total).toBe(2);
  });
  it("reads a closed day with its kept figures and note", () => {
    const p = parsePreview({
      ...good,
      closed: true,
      closed_at: "2026-11-18T22:00:00Z",
      override_note: "late arrival",
      kept_figures: figures({ rooms_sold: 4 }),
    })!;
    expect(p.closed).toBe(true);
    expect(p.override_note).toBe("late arrival");
    expect(p.kept_figures?.rooms_sold).toBe(4);
  });
  it("is null when a part is missing, so the page shows an error rather than wrong numbers", () => {
    expect(parsePreview({ ...good, items: null })).toBeNull();
    expect(parsePreview({ ...good, figures: null })).toBeNull();
    expect(parsePreview({ ...good, day: undefined })).toBeNull();
    expect(parsePreview(null)).toBeNull();
  });
});

describe("parseDays", () => {
  it("keeps good rows in the order given and drops bad ones", () => {
    const rows = parseDays([
      { day: "2026-11-18", closed: true, closed_at: "2026-11-18T22:00:00Z", open_items: 2, figures: figures(), changed_since_close: true },
      { day: "2026-11-17", closed: false, open_items: null, figures: figures(), changed_since_close: null },
      { closed: true },
      null,
    ]);
    expect(rows.map((r) => r.day)).toEqual(["2026-11-18", "2026-11-17"]);
    expect(rows[0]?.changed_since_close).toBe(true);
    expect(rows[1]?.changed_since_close).toBeNull();
    expect(rows[1]?.open_items).toBeNull();
  });
  it("returns nothing for a non-array", () => {
    expect(parseDays(null)).toEqual([]);
    expect(parseDays({})).toEqual([]);
  });
});

describe("classifyNightAuditError", () => {
  it("words each database refusal", () => {
    expect(classifyNightAuditError("POLICY_VIOLATION: future day")).toBe("na_future");
    expect(classifyNightAuditError("POLICY_VIOLATION: day too old")).toBe("na_old");
    expect(classifyNightAuditError("POLICY_VIOLATION: day required")).toBe("na_day");
    expect(classifyNightAuditError("INVALID_STATE: already closed")).toBe("na_closed");
    expect(classifyNightAuditError("POLICY_VIOLATION: open items need a note")).toBe("na_note_needed");
    expect(classifyNightAuditError("POLICY_VIOLATION: note length")).toBe("na_note_length");
  });
  it("leaves other refusals to the shared classifier", () => {
    expect(classifyNightAuditError("NOT_FOUND")).toBeNull();
    expect(classifyNightAuditError("IDEMPOTENCY_MISMATCH")).toBeNull();
    expect(classifyRpcError("NOT_FOUND").code).toBe("not_found");
  });
  it("every code has wording that the shared notice can find", () => {
    for (const code of Object.values(NIGHT_AUDIT_ERROR_MESSAGES)) expect(code.length).toBeGreaterThan(10);
    expect(errorMessage("na_closed", null, String)).toBe(NIGHT_AUDIT_ERROR_MESSAGES.na_closed);
    expect(errorMessage("na_note_needed", null, String)).toBe(NIGHT_AUDIT_ERROR_MESSAGES.na_note_needed);
    // not mistaken for the no-show note code, which shares the word "note"
    expect(errorMessage("na_note_length", null, String)).not.toBe(errorMessage("ns_note", null, String));
    expect("na_closed_clean" in OK_MESSAGES).toBe(false);
  });
});

describe("openItemsLabel", () => {
  it("says it plainly", () => {
    expect(openItemsLabel(0)).toBe("Nothing open");
    expect(openItemsLabel(1)).toBe("1 item open");
    expect(openItemsLabel(7)).toBe("7 items open");
  });
});
