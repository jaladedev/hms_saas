import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorMessage, OK_MESSAGES, type ErrorCode } from "./refunds";
import { MAX_NIGHTS } from "./new-reservation";
import {
  blockedText, classifyStayError, guestsPayload, parseStayForm, resultCode, STAY_OK_CODES, STAY_REASON_MAX, stayEditView,
} from "./stay-edit";

const RR1 = "6f1c1c1e-2b7a-4a55-9a43-1d2a8d9a1f10";
const RR2 = "7a2d2d2f-3c8b-4b66-8b54-2e3b9e0b2a21";
const good = { arrival: "2026-12-01", departure: "2026-12-04", reason: "  Guest stays longer ", [`adults_${RR1}`]: "2", [`children_${RR1}`]: "0" };

describe("stayEditView", () => {
  const base = { reservationStatus: "confirmed", rooms: [{ room_status: "booked" }], canModify: true, paymentCount: 0, liveInvoiceCount: 0 };
  it("offers the form for a confirmed, unpaid, uninvoiced booking to someone who may edit", () => {
    expect(stayEditView(base)).toEqual({ kind: "editable" });
  });
  it("stays quiet for people who may not edit and for bookings that cannot be edited at all", () => {
    expect(stayEditView({ ...base, canModify: false })).toEqual({ kind: "hidden" });
    for (const s of ["pending", "checked_in", "checked_out", "cancelled", "no_show", "expired"]) {
      expect(stayEditView({ ...base, reservationStatus: s }), s).toEqual({ kind: "hidden" });
    }
    expect(stayEditView({ ...base, rooms: [] })).toEqual({ kind: "hidden" });
    expect(stayEditView({ ...base, rooms: [{ room_status: "booked" }, { room_status: "checked_in" }] })).toEqual({ kind: "hidden" });
  });
  it("says why money stops the edit, payments first", () => {
    expect(stayEditView({ ...base, paymentCount: 1 })).toEqual({ kind: "blocked", why: "paid" });
    expect(stayEditView({ ...base, liveInvoiceCount: 1 })).toEqual({ kind: "blocked", why: "invoiced" });
    expect(stayEditView({ ...base, paymentCount: 2, liveInvoiceCount: 1 })).toEqual({ kind: "blocked", why: "paid" });
  });
  it("words both blocks and points at the way forward", () => {
    expect(blockedText("paid")).toMatch(/cancel the booking and book it again/);
    expect(blockedText("invoiced")).toMatch(/Void the invoice/);
  });
});

describe("parseStayForm", () => {
  it("reads a good form: dates, trimmed reason and the guests per room", () => {
    expect(parseStayForm(good)).toEqual({
      ok: true, value: { arrival: "2026-12-01", departure: "2026-12-04", reason: "Guest stays longer", guests: [{ reservationRoomId: RR1, adults: 2, children: 0 }] },
    });
  });
  it("reads every room on a multi-room booking and treats a missing children field as none", () => {
    const v = parseStayForm({ ...good, [`adults_${RR2}`]: "1", [`children_${RR2}`]: "1" });
    expect(v).toMatchObject({ ok: true, value: { guests: [{ reservationRoomId: RR1, adults: 2, children: 0 }, { reservationRoomId: RR2, adults: 1, children: 1 }] } });
    const { [`children_${RR1}`]: _gone, ...noChildren } = good;
    expect(parseStayForm(noChildren)).toMatchObject({ ok: true, value: { guests: [{ adults: 2, children: 0 }] } });
  });
  it("accepts a form with no guest fields at all (dates only)", () => {
    expect(parseStayForm({ arrival: "2026-12-01", departure: "2026-12-02", reason: "x" })).toMatchObject({ ok: true, value: { guests: [] } });
  });
  it("needs two real dates with the departure after the arrival", () => {
    for (const d of [{ arrival: "" }, { departure: undefined }, { arrival: "2026-02-30" }, { departure: "01/12/2026" }, { departure: "2026-12-01" }, { departure: "2026-11-30" }]) {
      expect(parseStayForm({ ...good, ...d }), JSON.stringify(d)).toEqual({ ok: false, code: "se_dates" });
    }
  });
  it("caps a stay at 30 nights", () => {
    expect(parseStayForm({ ...good, arrival: "2026-12-01", departure: "2026-12-31" }).ok).toBe(true);
    expect(parseStayForm({ ...good, arrival: "2026-12-01", departure: "2027-01-01" })).toEqual({ ok: false, code: "se_too_long" });
    expect(MAX_NIGHTS).toBe(30);
  });
  it("needs a reason of up to 200 characters", () => {
    for (const reason of ["", "   ", undefined]) expect(parseStayForm({ ...good, reason }), String(reason)).toEqual({ ok: false, code: "se_reason" });
    expect(parseStayForm({ ...good, reason: "r".repeat(STAY_REASON_MAX + 1) })).toEqual({ ok: false, code: "se_reason" });
    expect(parseStayForm({ ...good, reason: "r".repeat(STAY_REASON_MAX) }).ok).toBe(true);
  });
  it("refuses whole-number problems in the guest fields as a capacity problem, and a bad room id as a room problem", () => {
    for (const adults of ["0", "-1", "1.5", "two", "", "21", "100"]) {
      expect(parseStayForm({ ...good, [`adults_${RR1}`]: adults }), adults).toEqual({ ok: false, code: "se_capacity" });
    }
    for (const children of ["-1", "x", "21"]) expect(parseStayForm({ ...good, [`children_${RR1}`]: children }), children).toEqual({ ok: false, code: "se_capacity" });
    expect(parseStayForm({ ...good, adults_notanid: "1" })).toEqual({ ok: false, code: "se_room" });
  });
  it("ignores a file posted in place of text", () => {
    expect(parseStayForm({ ...good, reason: new File(["x"], "x.txt") })).toEqual({ ok: false, code: "se_reason" });
  });
  it("builds the database payload in its own field names", () => {
    expect(guestsPayload([{ reservationRoomId: RR1, adults: 2, children: 1 }])).toEqual([{ reservation_room_id: RR1, adults: 2, children: 1 }]);
    expect(guestsPayload([])).toEqual([]);
  });
});

describe("resultCode", () => {
  it("tells apart a change, a change that moved a guest, and nothing to change", () => {
    expect(resultCode({ changed: true, rooms_moved: 0 })).toBe("se_changed");
    expect(resultCode({ changed: true })).toBe("se_changed");
    expect(resultCode({ changed: true, rooms_moved: 2 })).toBe("se_changed_moved");
    expect(resultCode({ changed: false })).toBe("se_nochange");
    expect(resultCode(null)).toBe("se_changed");
  });
});

describe("classifyStayError", () => {
  it("maps every text migration 033 can raise", () => {
    const cases: [string, ErrorCode][] = [
      ["NOT_FOUND", "se_not_found"], ["FORBIDDEN", "se_not_found"], ["IDEMPOTENCY_MISMATCH", "se_duplicate"],
      ["INVALID_STATE: money held", "se_paid"], ["INVALID_STATE: invoice", "se_invoiced"], ["INVALID_STATE: payment started", "se_payment_started"],
      ["INVALID_STATE: split stay", "se_split"], ["INVALID_STATE: cancelled", "se_not_editable"], ["INVALID_STATE: pending", "se_not_editable"],
      ["INVALID_STATE: checked_in", "se_not_editable"], ["INVALID_STATE: room", "se_not_editable"],
      ["CAPACITY_EXCEEDED", "se_capacity"], ["ROOM_UNAVAILABLE", "se_unavailable"], ["RATE_MISSING: no rate", "se_rate"],
      ["POLICY_VIOLATION: reason", "se_reason"], ["POLICY_VIOLATION: departure must follow arrival", "se_dates"],
      ["POLICY_VIOLATION: stay too long", "se_too_long"], ["POLICY_VIOLATION: arrival in the past", "se_arrival_past"],
      ["POLICY_VIOLATION: guests", "se_capacity"], ["POLICY_VIOLATION: room", "se_room"], ["POLICY_VIOLATION: discount", "se_discount"],
    ];
    for (const [message, code] of cases) expect(classifyStayError(message), message).toBe(code);
  });
  it("answers anything unexpected as unknown, and always with a stay code", () => {
    expect(classifyStayError("connection reset by peer")).toBe("se_unknown");
    expect(classifyStayError("")).toBe("se_unknown");
    for (const m of ["NOT_FOUND", "boom", "INVALID_STATE: x", "POLICY_VIOLATION: other"]) expect(classifyStayError(m)).toMatch(/^se_/);
  });
  it("matches the texts migration 033 really raises, so a reworded refusal cannot slip through as unknown", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000033_update_reservation_stay.sql", import.meta.url), "utf8");
    const raised = [...sql.matchAll(/raise exception '([A-Z_]+(?:: [^'%]*)?)(?:%)?'/g)].map((m) => m[1]!.trim());
    expect(raised.length).toBeGreaterThan(12);
    for (const text of raised) expect(classifyStayError(text), text).not.toBe("se_unknown");
  });
});

describe("words for the edit", () => {
  const codes: ErrorCode[] = [
    "se_dates", "se_too_long", "se_reason", "se_room", "se_capacity", "se_arrival_past", "se_unavailable", "se_rate", "se_paid", "se_invoiced",
    "se_payment_started", "se_split", "se_not_editable", "se_discount", "se_not_found", "se_duplicate",
  ];
  it("has a plain sentence for every error code and never echoes raw database text", () => {
    for (const c of codes) {
      const text = errorMessage(c, null, String);
      expect(text, c).not.toMatch(/Something went wrong/);
      expect(text, c).not.toMatch(/P0001|POLICY_VIOLATION|FORBIDDEN|INVALID_STATE|NOT_FOUND|CAPACITY_EXCEEDED|ROOM_UNAVAILABLE/);
    }
    expect(errorMessage("se_unknown", null, String)).toMatch(/Something went wrong/);
  });
  it("says a failed change leaves the booking as it was, and what to do about money", () => {
    expect(errorMessage("se_unavailable", null, String)).toMatch(/nothing was changed/);
    expect(errorMessage("se_paid", null, String)).toMatch(/Cancel it and book it again/);
    expect(errorMessage("se_invoiced", null, String)).toMatch(/Void the invoice first/);
    expect(errorMessage("se_split", null, String)).toMatch(/Guest numbers can still be changed/);
  });
  it("has a success sentence for every result, and warns when a guest was given a different room", () => {
    for (const c of STAY_OK_CODES) expect(OK_MESSAGES[c], c).toBeTruthy();
    expect(OK_MESSAGES.se_changed_moved).toMatch(/different room/);
    expect(OK_MESSAGES.se_changed).toMatch(/keep their price/);
  });
});

describe("the form against the database's own rules", () => {
  it("uses the same limits as migration 033", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000033_update_reservation_stay.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/p_departure - p_arrival > 30/);
    expect(sql).toMatch(/length\(v_reason\) > 200/);
    expect(STAY_REASON_MAX).toBe(200);
    expect(MAX_NIGHTS).toBe(30);
    // the permission the screen asks about is the one the function enforces
    expect(sql).toMatch(/require_permission\(r\.property_id, 'reservation\.modify'/);
  });
});
