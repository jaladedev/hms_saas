import { describe, expect, it } from "vitest";
import { classifyRpcError, errorMessage } from "./refunds";
import {
  attentionText, detailActions, listQuery, nightsBetween, parseFilters, parseIsoDate, sanitizeSearch, sortAscending, statusesFor, todayIn,
  type ResState, type Viewer,
} from "./reservations";

const ALL: Viewer = { cancel: true, checkin: true, checkout: true, payment: true };
const NONE: Viewer = { cancel: false, checkin: false, checkout: false, payment: false };

function res(over: Partial<ResState> = {}): ResState {
  return { reservation_status: "confirmed", arrival_date: "2026-11-02", departure_date: "2026-11-05", total_minor: 9000000, cancellation_charge_minor: 0, ...over };
}

describe("sanitizeSearch", () => {
  it("keeps names, references, emails and phone-like text", () => {
    expect(sanitizeSearch("HMS-8K2Q")).toBe("HMS-8K2Q");
    expect(sanitizeSearch("Adéyemi Bọlá")).toBe("Adéyemi Bọlá");
    expect(sanitizeSearch("ade@example.com")).toBe("ade@example.com");
  });
  it("drops characters that mean something inside a filter string", () => {
    expect(sanitizeSearch("a,b)(c%d_e*f")).toBe("a b c d e f");
    expect(sanitizeSearch("x.or(id.eq.1)")).not.toMatch(/[(),]/);
    expect(sanitizeSearch("  too   many   spaces ")).toBe("too many spaces");
  });
  it("handles empty input and caps the length", () => {
    expect(sanitizeSearch(undefined)).toBe("");
    expect(sanitizeSearch("")).toBe("");
    expect(sanitizeSearch("a".repeat(200))).toHaveLength(60);
  });
});

describe("parseIsoDate", () => {
  it("accepts real dates only", () => {
    expect(parseIsoDate("2026-11-02")).toBe("2026-11-02");
    expect(parseIsoDate("2028-02-29")).toBe("2028-02-29");
    for (const bad of ["2026-02-30", "2026-13-01", "02/11/2026", "2026-1-2", "", undefined, "2026-11-02T00:00"]) {
      expect(parseIsoDate(bad as string | undefined), String(bad)).toBeNull();
    }
  });
});

describe("parseFilters and listQuery", () => {
  it("defaults to open reservations on page one", () => {
    expect(parseFilters({})).toEqual({ q: "", status: "open", from: null, to: null, page: 1 });
  });
  it("falls back safely on junk", () => {
    const f = parseFilters({ status: "bogus", page: "-3", from: "nope", to: "2026-99-99", q: "a,b" });
    expect(f).toEqual({ q: "a b", status: "open", from: null, to: null, page: 1 });
    expect(parseFilters({ page: "2.5" }).page).toBe(1);
    expect(parseFilters({ page: "99999999" }).page).toBe(1);
  });
  it("reads every filter, taking the first of repeated parameters", () => {
    const f = parseFilters({ q: ["Ade", "x"], status: "cancelled", from: "2026-11-01", to: "2026-11-30", page: "3" });
    expect(f).toEqual({ q: "Ade", status: "cancelled", from: "2026-11-01", to: "2026-11-30", page: 3 });
  });
  it("leaves defaults out of links and round-trips the rest", () => {
    expect(listQuery(parseFilters({}))).toBe("");
    const f = parseFilters({ q: "Ade", status: "cancelled", from: "2026-11-01", page: "2" });
    expect(listQuery(f)).toBe("?q=Ade&status=cancelled&from=2026-11-01&page=2");
    expect(parseFilters(Object.fromEntries(new URLSearchParams(listQuery(f)))).page).toBe(2);
    expect(listQuery(f, { page: 1 })).toBe("?q=Ade&status=cancelled&from=2026-11-01");
  });
});

describe("statusesFor and sortAscending", () => {
  it("maps each filter to the statuses it stands for", () => {
    expect(statusesFor("open")).toEqual(["pending", "confirmed", "checked_in"]);
    expect(statusesFor("all")).toBeNull();
    expect(statusesFor("attention")).toBeNull();
    expect(statusesFor("cancelled")).toEqual(["cancelled"]);
  });
  it("lists upcoming work soonest first and history newest first", () => {
    expect(sortAscending("open")).toBe(true);
    expect(sortAscending("attention")).toBe(true);
    expect(sortAscending("all")).toBe(false);
    expect(sortAscending("checked_out")).toBe(false);
  });
});

describe("dates", () => {
  it("finds today's date in the property's own timezone", () => {
    const t = new Date("2026-10-31T23:30:00Z");
    expect(todayIn("UTC", t)).toBe("2026-10-31");
    expect(todayIn("Africa/Lagos", t)).toBe("2026-11-01");   // UTC+1
    expect(todayIn("Pacific/Auckland", t)).toBe("2026-11-01");
    expect(todayIn("Not/AZone", t)).toBe("2026-10-31");      // unknown zone falls back to UTC
  });
  it("counts nights, departure exclusive", () => {
    expect(nightsBetween("2026-11-02", "2026-11-05")).toBe(3);
    expect(nightsBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(nightsBetween("bad", "2026-11-05")).toBe(0);
  });
});

describe("detailActions", () => {
  const booked = { room_status: "booked" };
  const inHouse = { room_status: "checked_in" };

  it("offers cancel only while the booking can still be cancelled", () => {
    expect(detailActions(res({ reservation_status: "pending" }), ALL, "2026-11-01", 0).cancel).toBe(true);
    expect(detailActions(res(), ALL, "2026-11-01", 0).cancel).toBe(true);
    for (const s of ["checked_in", "checked_out", "cancelled", "no_show", "expired"]) {
      expect(detailActions(res({ reservation_status: s }), ALL, "2026-11-01", 0).cancel, s).toBe(false);
    }
    expect(detailActions(res(), NONE, "2026-11-01", 0).cancel).toBe(false);
  });

  it("offers check-in only on a stay night, for a room that has not arrived", () => {
    const at = (today: string) => detailActions(res(), ALL, today, 0).checkIn(booked);
    expect(at("2026-11-01")).toBe(false);   // before arrival: the database refuses early check-in
    expect(at("2026-11-02")).toBe(true);    // arrival day
    expect(at("2026-11-04")).toBe(true);    // last night
    expect(at("2026-11-05")).toBe(false);   // departure day: the stay has ended
    expect(detailActions(res(), ALL, "2026-11-02", 0).checkIn(inHouse)).toBe(false);
    expect(detailActions(res({ reservation_status: "pending" }), ALL, "2026-11-02", 0).checkIn(booked)).toBe(false);
    expect(detailActions(res({ reservation_status: "checked_in" }), ALL, "2026-11-03", 0).checkIn(booked)).toBe(true);   // second room of a multi-room stay
    expect(detailActions(res(), NONE, "2026-11-02", 0).checkIn(booked)).toBe(false);
  });

  it("offers check-out for a room that is in house, whatever the date", () => {
    expect(detailActions(res({ reservation_status: "checked_in" }), ALL, "2026-11-03", 0).checkOut(inHouse)).toBe(true);
    expect(detailActions(res({ reservation_status: "checked_in" }), ALL, "2026-11-03", 0).checkOut(booked)).toBe(false);
    expect(detailActions(res({ reservation_status: "checked_in" }), NONE, "2026-11-03", 0).checkOut(inHouse)).toBe(false);
  });

  it("caps payments at the total, or at the unpaid cancellation charge", () => {
    expect(detailActions(res(), ALL, "2026-11-01", 0)).toMatchObject({ recordPayment: true, payableCeilingMinor: 9000000 });
    expect(detailActions(res(), ALL, "2026-11-01", 9000000).recordPayment).toBe(false);          // fully paid
    expect(detailActions(res(), ALL, "2026-11-01", null).recordPayment).toBe(true);              // money held unknown: let the database decide
    expect(detailActions(res(), NONE, "2026-11-01", 0).recordPayment).toBe(false);
    const cancelled = res({ reservation_status: "cancelled", cancellation_charge_minor: 2000000 });
    expect(detailActions(cancelled, ALL, "2026-11-01", 500000)).toMatchObject({ recordPayment: true, payableCeilingMinor: 2000000 });
    expect(detailActions(cancelled, ALL, "2026-11-01", 2000000).recordPayment).toBe(false);      // charge covered
    expect(detailActions(res({ reservation_status: "cancelled" }), ALL, "2026-11-01", 0).recordPayment).toBe(false);   // no charge at all
    for (const s of ["expired", "no_show"]) {
      expect(detailActions(res({ reservation_status: s }), ALL, "2026-11-01", 0).recordPayment, s).toBe(false);
    }
  });
});

describe("how the database's refusals are worded", () => {
  const fmt = (m: number) => `₦${m / 100}`;
  it("recognises check-in, check-out and payment refusals", () => {
    expect(classifyRpcError("INVALID_STATE: ROOM_NOT_READY").code).toBe("room_not_ready");
    expect(classifyRpcError("INVALID_STATE: ROOM_NOT_ACTIVE").code).toBe("room_not_active");
    expect(classifyRpcError("POLICY_VIOLATION: PAYMENT_REQUIRED").code).toBe("payment_required");
    expect(classifyRpcError("POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED").code).toBe("early_checkin");
    expect(classifyRpcError("INVALID_STATE: stay already ended").code).toBe("stay_ended");
    expect(classifyRpcError("INVALID_STATE: no stay claim for today").code).toBe("no_stay_claim");
    expect(classifyRpcError("POLICY_VIOLATION: payment method").code).toBe("method_invalid");
    expect(classifyRpcError("INVALID_STATE: checked_in").code).toBe("invalid_state");
  });
  it("carries the outstanding amount for an overpayment", () => {
    expect(classifyRpcError("POLICY_VIOLATION: OVERPAYMENT outstanding 250000")).toEqual({ code: "overpayment", refundableMinor: 250000 });
    expect(errorMessage("overpayment", 250000, fmt)).toContain("₦2500");
    expect(errorMessage("overpayment", null, fmt)).toMatch(/more than is owed/);
  });
  it("has a sentence for every new code and never echoes database text", () => {
    for (const c of ["room_not_ready", "room_not_active", "payment_required", "early_checkin", "stay_ended", "no_stay_claim", "method_invalid", "not_cancellable"]) {
      const m = errorMessage(c, null, fmt);
      expect(m, c).not.toMatch(/Nothing was changed/);
      expect(m, c).not.toMatch(/INVALID_STATE|POLICY_VIOLATION/);
    }
  });
});

describe("attentionText", () => {
  it("explains known reasons and shows unknown ones as given", () => {
    expect(attentionText("paid_after_cancel")).toMatch(/refund/);
    expect(attentionText("payment_overpayment")).toMatch(/needs review/);
    expect(attentionText("something_new")).toContain("something_new");
  });
});

describe("invoiceActions", () => {
  const live = { id: "i1", invoice_number: "INV-1", invoice_status: "issued", total_minor: 100 };
  const voided = { ...live, id: "i2", invoice_status: "void" };
  const ALLP = { issue: true, void: true };
  it("offers issue only when no live invoice exists and the booking is not closed", async () => {
    const { invoiceActions } = await import("./reservations");
    expect(invoiceActions("confirmed", [], ALLP).canIssue).toBe(true);
    expect(invoiceActions("confirmed", [voided], ALLP).canIssue).toBe(true);     // reissue after a void
    expect(invoiceActions("confirmed", [live], ALLP).canIssue).toBe(false);
    expect(invoiceActions("checked_in", [], { issue: false, void: true }).canIssue).toBe(false);
    for (const s of ["cancelled", "expired", "no_show"]) expect(invoiceActions(s, [], ALLP).canIssue, s).toBe(false);
  });
  it("offers void only on a live invoice, with permission", async () => {
    const { invoiceActions } = await import("./reservations");
    const a = invoiceActions("confirmed", [live, voided], ALLP);
    expect(a.canVoid(live)).toBe(true);
    expect(a.canVoid(voided)).toBe(false);
    expect(invoiceActions("confirmed", [live], { issue: true, void: false }).canVoid(live)).toBe(false);
  });
  it("words the invoice refusals", async () => {
    const { classifyRpcError, errorMessage } = await import("./refunds");
    expect(classifyRpcError("INVALID_STATE: invoice exists").code).toBe("invoice_exists");
    expect(classifyRpcError("INVALID_STATE: invoice has payments").code).toBe("invoice_has_payments");
    expect(classifyRpcError("INVALID_STATE: void").code).toBe("invoice_void");
    expect(errorMessage("invoice_has_payments", null, String)).toMatch(/Refund the guest first/);
  });
});
