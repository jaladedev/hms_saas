import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_LABEL, checkoutNote, classifyFolioError, FOLIO_CATEGORIES, FOLIO_LIMITS, FOLIO_OK_CODES, folioActions, folioIsOpen,
  isFolioCategory, isFolioResult, owingMinor, owingNotice, parseChargeForm, parsePaymentForm, parseReason, prefillPayment,
  splitCharges, splitPayments, type ChargeRow, type FolioBalance, type FolioViewer, type PaymentRow,
} from "./folio";
import { errorMessage, OK_MESSAGES, type ErrorCode } from "./refunds";
import { PAYMENT_METHODS } from "./reservations";

const money = (m: number) => `N${m / 100}`;
const ROOM = "6f1c1c1e-2b7a-4a55-9a43-1d2a8d9a1f10";

const charge = (id: string, over: Partial<ChargeRow> = {}): ChargeRow => ({
  id, reservation_room_id: null, category: "minibar", description: `Item ${id}`, quantity: 1, unit_amount_minor: 100000, tax_minor: 0,
  total_minor: 100000, charge_date: "2026-11-02", status: "posted", created_at: "2026-11-02T10:00:00Z", voided_at: null, void_reason: null, folio_invoice_id: null, ...over,
});
const payment = (id: string, over: Partial<PaymentRow> = {}): PaymentRow => ({
  id, payment_method: "cash", provider_reference: null, internal_reference: `FOL-${id}`, amount_minor: 100000, payment_status: "succeeded",
  note: null, received_at: "2026-11-02T12:00:00Z", reversed_at: null, reverse_reason: null, ...over,
});
const bal = (over: Partial<FolioBalance> = {}): FolioBalance => ({
  currency: "NGN", charge_count: 2, charges_minor: 500000, tax_minor: 0, paid_minor: 0, balance_minor: 500000, ...over,
});
const ALL: FolioViewer = { charge: true, record: true, reverse: true };
const NONE: FolioViewer = { charge: false, record: false, reverse: false };

describe("categories and the database's lists", () => {
  it("uses plain words, with a label for every category", () => {
    expect(FOLIO_CATEGORIES.map((c) => c.label)).toEqual(["Minibar", "Food and drink", "Laundry", "Late check-out", "Phone calls", "Damage or loss", "Something else"]);
    for (const c of FOLIO_CATEGORIES) expect(CATEGORY_LABEL[c.value]).toBe(c.label);
    expect(isFolioCategory("laundry")).toBe(true);
    expect(isFolioCategory("food_beverage")).toBe(true);
    expect(isFolioCategory("spa")).toBe(false);
    expect(isFolioCategory("")).toBe(false);
  });
  it("offers exactly the categories and payment methods the migration allows", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000027_folio_charges.sql", import.meta.url), "utf8");
    const list = (re: RegExp) => [...(re.exec(sql)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(list(/category\s+text not null check \(category in \(([^)]*)\)/)).toEqual(FOLIO_CATEGORIES.map((c) => c.value).sort());
    expect(list(/payment_method\s+text not null check \(payment_method in \(([^)]*)\)/)).toEqual(PAYMENT_METHODS.map((m) => m.value).sort());
  });
  it("repeats the database's limits", () => {
    expect(FOLIO_LIMITS).toEqual({ quantityMax: 1000, unitMaxMinor: 1_000_000_000, descriptionMax: 200, reasonMax: 200, referenceMax: 100, noteMax: 500 });
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000027_folio_charges.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/quantity\s+integer not null check \(quantity between 1 and 1000\)/);
    expect(sql).toMatch(/unit_amount_minor\s+bigint not null check \(unit_amount_minor between 1 and 1000000000\)/);
    expect(sql).toMatch(/length\(description\) between 1 and 200/);
  });
});

describe("folioIsOpen", () => {
  it("is true only for a guest in the house or just left", () => {
    expect(folioIsOpen("checked_in")).toBe(true);
    expect(folioIsOpen("checked_out")).toBe(true);
    for (const s of ["pending", "confirmed", "cancelled", "no_show", "expired"]) expect(folioIsOpen(s), s).toBe(false);
  });
});

describe("splitCharges and splitPayments", () => {
  it("lists posted charges in the order they happened and voided ones latest first", () => {
    const { posted, voided } = splitCharges([
      charge("late", { charge_date: "2026-11-04" }),
      charge("b", { charge_date: "2026-11-02", created_at: "2026-11-02T11:00:00Z" }),
      charge("a", { charge_date: "2026-11-02", created_at: "2026-11-02T09:00:00Z" }),
      charge("v1", { status: "voided", voided_at: "2026-11-03T08:00:00Z", void_reason: "x" }),
      charge("v2", { status: "voided", voided_at: "2026-11-03T09:00:00Z", void_reason: "y" }),
    ]);
    expect(posted.map((c) => c.id)).toEqual(["a", "b", "late"]);
    expect(voided.map((c) => c.id)).toEqual(["v2", "v1"]);
  });
  it("lists money in the order it came in and reversed payments latest first", () => {
    const { received, reversed } = splitPayments([
      payment("2", { received_at: "2026-11-02T15:00:00Z" }),
      payment("1", { received_at: "2026-11-02T09:00:00Z" }),
      payment("r1", { payment_status: "reversed", reversed_at: "2026-11-03T08:00:00Z", reverse_reason: "x" }),
      payment("r2", { payment_status: "reversed", reversed_at: "2026-11-03T10:00:00Z", reverse_reason: "y" }),
    ]);
    expect(received.map((p) => p.id)).toEqual(["1", "2"]);
    expect(reversed.map((p) => p.id)).toEqual(["r2", "r1"]);
  });
  it("copes with nothing at all", () => {
    expect(splitCharges([])).toEqual({ posted: [], voided: [] });
    expect(splitPayments([])).toEqual({ received: [], reversed: [] });
  });
});

describe("folioActions", () => {
  it("offers everything to someone who holds every permission while the folio is open and owing", () => {
    const a = folioActions("checked_in", bal(), ALL);
    expect(a.post).toBe(true);
    expect(a.recordPayment).toBe(true);
    expect(a.payableCeilingMinor).toBe(500000);
    expect(a.voidCharge(charge("a"))).toBe(true);
    expect(a.reversePayment(payment("p"))).toBe(true);
  });
  it("offers nothing to someone with no folio permissions", () => {
    const a = folioActions("checked_in", bal(), NONE);
    expect(a.post).toBe(false);
    expect(a.recordPayment).toBe(false);
    expect(a.voidCharge(charge("a"))).toBe(false);
    expect(a.voidBlockedByPayment(charge("a"))).toBe(false);
    expect(a.reversePayment(payment("p"))).toBe(false);
  });
  it("splits the three permissions: posting, taking money, and reversing it", () => {
    expect(folioActions("checked_in", bal(), { charge: true, record: false, reverse: false }).post).toBe(true);
    expect(folioActions("checked_in", bal(), { charge: true, record: false, reverse: false }).recordPayment).toBe(false);
    // An accountant takes and reverses money but does not post charges.
    const acct = folioActions("checked_out", bal({ paid_minor: 100000, balance_minor: 400000 }), { charge: false, record: true, reverse: true });
    expect(acct.post).toBe(false);
    expect(acct.recordPayment).toBe(true);
    expect(acct.voidCharge(charge("a"))).toBe(false);
    expect(acct.reversePayment(payment("p"))).toBe(true);
    // Front desk can take money but not undo it, so the person who took it cannot also reverse it.
    expect(folioActions("checked_in", bal(), { charge: true, record: true, reverse: false }).reversePayment(payment("p"))).toBe(false);
  });
  it("still lets a guest who has just left be charged and pay", () => {
    const a = folioActions("checked_out", bal(), ALL);
    expect(a.post).toBe(true);
    expect(a.recordPayment).toBe(true);
  });
  it("offers nothing before arrival or after a cancellation", () => {
    for (const s of ["pending", "confirmed", "cancelled", "no_show", "expired"]) {
      const a = folioActions(s, bal(), ALL);
      expect(a.post, s).toBe(false);
      expect(a.recordPayment, s).toBe(false);
      expect(a.voidCharge(charge("a")), s).toBe(false);
      expect(a.reversePayment(payment("p")), s).toBe(false);
    }
  });
  it("offers no payment form once nothing is owed", () => {
    const a = folioActions("checked_in", bal({ paid_minor: 500000, balance_minor: 0 }), ALL);
    expect(a.recordPayment).toBe(false);
    expect(a.payableCeilingMinor).toBe(0);
    expect(folioActions("checked_in", bal({ charges_minor: 0, charge_count: 0, balance_minor: 0 }), ALL).recordPayment).toBe(false);
  });
  it("refuses a void the database would refuse: money collected would exceed the charges left", () => {
    // 5,000 charged, 4,500 paid: voiding a 1,000 charge leaves 4,000 against 4,500 collected.
    const b = bal({ charges_minor: 500000, paid_minor: 450000, balance_minor: 50000 });
    const a = folioActions("checked_in", b, ALL);
    expect(a.voidCharge(charge("big", { total_minor: 100000 }))).toBe(false);
    expect(a.voidBlockedByPayment(charge("big", { total_minor: 100000 }))).toBe(true);
    // A 500 charge leaves exactly 4,500 against 4,500 collected: allowed (the database's rule is paid <= remaining).
    expect(a.voidCharge(charge("small", { total_minor: 50000 }))).toBe(true);
    expect(a.voidBlockedByPayment(charge("small", { total_minor: 50000 }))).toBe(false);
    // Nothing paid: any charge can go.
    expect(folioActions("checked_in", bal(), ALL).voidCharge(charge("any", { total_minor: 500000 }))).toBe(true);
  });
  it("does not offer to void or reverse what is already voided or reversed", () => {
    const a = folioActions("checked_in", bal(), ALL);
    expect(a.voidCharge(charge("v", { status: "voided" }))).toBe(false);
    expect(a.voidBlockedByPayment(charge("v", { status: "voided" }))).toBe(false);
    expect(a.reversePayment(payment("r", { payment_status: "reversed" }))).toBe(false);
  });
});

describe("owing warnings", () => {
  it("never goes below zero and reads no balance as nothing owed", () => {
    expect(owingMinor(null)).toBe(0);
    expect(owingMinor(bal({ balance_minor: 250000 }))).toBe(250000);
    expect(owingMinor(bal({ balance_minor: -5 }))).toBe(0);
  });
  it("warns beside Check out only when something is owed, and says check-out is not blocked", () => {
    expect(checkoutNote(0, money)).toBeNull();
    const note = checkoutNote(250000, money);
    expect(note).toMatch(/N2500 is still owed for extras/);
    expect(note).toMatch(/can still check the guest out/);
  });
  it("words the folio headline for a guest still here and one who has left", () => {
    expect(owingNotice("checked_in", 0, money)).toBeNull();
    expect(owingNotice("checked_in", 100000, money)).toBe("N1000 is owed for extras so far. It does not stop check-out.");
    expect(owingNotice("checked_out", 100000, money)).toBe("The guest has checked out with N1000 still owed for extras.");
  });
  it("prefills a payment with everything owed, and nothing when nothing is", () => {
    expect(prefillPayment(1250050)).toBe("12500.50");
    expect(prefillPayment(100)).toBe("1.00");
    expect(prefillPayment(0)).toBe("");
  });
});

describe("parseChargeForm", () => {
  const good = { category: "minibar", description: "  2 bottles of water ", quantity: "2", amount: "1,500.50", date: "2026-11-02", reservationRoomId: "" };
  it("reads a good form into kobo and trims the words", () => {
    expect(parseChargeForm(good)).toEqual({
      ok: true, value: { category: "minibar", description: "2 bottles of water", quantity: 2, unitAmountMinor: 150050, date: "2026-11-02", roomId: null },
    });
  });
  it("treats an empty date as today (the database decides what today is) and keeps a room that looks like an id", () => {
    const v = parseChargeForm({ ...good, date: "", reservationRoomId: ROOM });
    expect(v).toMatchObject({ ok: true, value: { date: null, roomId: ROOM } });
  });
  it("refuses an unknown or missing category", () => {
    for (const category of ["spa", "", undefined]) expect(parseChargeForm({ ...good, category }), String(category)).toEqual({ ok: false, code: "fo_category" });
  });
  it("needs words of up to 200 characters", () => {
    expect(parseChargeForm({ ...good, description: "   " })).toEqual({ ok: false, code: "fo_description" });
    expect(parseChargeForm({ ...good, description: undefined })).toEqual({ ok: false, code: "fo_description" });
    expect(parseChargeForm({ ...good, description: "a".repeat(201) })).toEqual({ ok: false, code: "fo_description" });
    expect(parseChargeForm({ ...good, description: "a".repeat(200) }).ok).toBe(true);
  });
  it("needs a whole quantity from 1 to 1000", () => {
    for (const quantity of ["0", "1001", "-1", "1.5", "two", "", undefined, "10000"]) {
      expect(parseChargeForm({ ...good, quantity }), String(quantity)).toEqual({ ok: false, code: "fo_quantity" });
    }
    expect(parseChargeForm({ ...good, quantity: "1000" }).ok).toBe(true);
    expect(parseChargeForm({ ...good, quantity: "1" }).ok).toBe(true);
  });
  it("needs a price above zero and no more than 10,000,000", () => {
    for (const amount of ["0", "-5", "abc", "", undefined, "1.234", "10000000.01", "10,000,001"]) {
      expect(parseChargeForm({ ...good, amount }), String(amount)).toEqual({ ok: false, code: "fo_amount" });
    }
    expect(parseChargeForm({ ...good, amount: "10000000" })).toMatchObject({ ok: true, value: { unitAmountMinor: 1_000_000_000 } });
    expect(parseChargeForm({ ...good, amount: "₦ 750" })).toMatchObject({ ok: true, value: { unitAmountMinor: 75000 } });
  });
  it("refuses a date that is not a real day", () => {
    for (const date of ["2026-02-30", "02/11/2026", "yesterday"]) expect(parseChargeForm({ ...good, date }), date).toEqual({ ok: false, code: "fo_date" });
  });
  it("refuses a room that is not an id", () => {
    expect(parseChargeForm({ ...good, reservationRoomId: "room 204" })).toEqual({ ok: false, code: "fo_room" });
  });
  it("ignores a file field posted in place of text", () => {
    expect(parseChargeForm({ ...good, description: new File(["x"], "x.txt") })).toEqual({ ok: false, code: "fo_description" });
  });
});

describe("parsePaymentForm", () => {
  const good = { amount: "2,000", method: "pos", reference: " 88123 ", note: " tip included " };
  it("reads a good form and trims", () => {
    expect(parsePaymentForm(good)).toEqual({ ok: true, value: { amountMinor: 200000, method: "pos", reference: "88123", note: "tip included" } });
  });
  it("turns empty optional fields into null", () => {
    expect(parsePaymentForm({ amount: "10", method: "cash", reference: "", note: "  " })).toEqual({
      ok: true, value: { amountMinor: 1000, method: "cash", reference: null, note: null },
    });
    expect(parsePaymentForm({ amount: "10", method: "cash" }).ok).toBe(true);
  });
  it("refuses a bad amount, an unknown method and words that are too long", () => {
    for (const amount of ["0", "-1", "x", "", undefined]) expect(parsePaymentForm({ ...good, amount }), String(amount)).toEqual({ ok: false, code: "fo_amount" });
    for (const method of ["card", "", undefined, "paystack"]) expect(parsePaymentForm({ ...good, method }), String(method)).toEqual({ ok: false, code: "fo_method" });
    expect(parsePaymentForm({ ...good, reference: "r".repeat(101) })).toEqual({ ok: false, code: "fo_too_long" });
    expect(parsePaymentForm({ ...good, note: "n".repeat(501) })).toEqual({ ok: false, code: "fo_too_long" });
    expect(parsePaymentForm({ ...good, reference: "r".repeat(100), note: "n".repeat(500) }).ok).toBe(true);
  });
});

describe("parseReason", () => {
  it("needs a reason of up to 200 characters", () => {
    expect(parseReason("  Wrong room  ")).toEqual({ ok: true, value: "Wrong room" });
    expect(parseReason("")).toEqual({ ok: false, code: "fo_reason" });
    expect(parseReason("   ")).toEqual({ ok: false, code: "fo_reason" });
    expect(parseReason(undefined)).toEqual({ ok: false, code: "fo_reason" });
    expect(parseReason("r".repeat(201))).toEqual({ ok: false, code: "fo_reason" });
    expect(parseReason("r".repeat(200)).ok).toBe(true);
  });
});

describe("classifyFolioError", () => {
  it("reads the amount still outstanding from an overpayment", () => {
    expect(classifyFolioError("POLICY_VIOLATION: OVERPAYMENT outstanding 250000")).toEqual({ code: "fo_overpay", n: 250000 });
    expect(classifyFolioError("POLICY_VIOLATION: OVERPAYMENT outstanding 0")).toEqual({ code: "fo_overpay", n: 0 });
  });
  it("tells a folio that cannot be voided from a reservation with no folio", () => {
    expect(classifyFolioError("INVALID_STATE: folio paid")).toEqual({ code: "fo_paid" });
    for (const s of ["confirmed", "pending", "cancelled", "no_show", "expired"]) expect(classifyFolioError(`INVALID_STATE: ${s}`), s).toEqual({ code: "fo_not_open" });
  });
  it("words each refused field", () => {
    const cases: [string, ErrorCode][] = [
      ["POLICY_VIOLATION: category", "fo_category"], ["POLICY_VIOLATION: description", "fo_description"], ["POLICY_VIOLATION: quantity", "fo_quantity"],
      ["POLICY_VIOLATION: amount", "fo_amount"], ["POLICY_VIOLATION: amount must be positive", "fo_amount"], ["POLICY_VIOLATION: date", "fo_date"],
      ["POLICY_VIOLATION: room", "fo_room"], ["POLICY_VIOLATION: reason", "fo_reason"], ["POLICY_VIOLATION: payment method", "fo_method"],
      ["POLICY_VIOLATION: too long", "fo_too_long"], ["IDEMPOTENCY_MISMATCH", "fo_duplicate"],
    ];
    for (const [message, code] of cases) expect(classifyFolioError(message), message).toEqual({ code });
  });
  it("answers not found and forbidden alike, and anything unexpected as unknown", () => {
    expect(classifyFolioError("NOT_FOUND")).toEqual({ code: "fo_not_found" });
    expect(classifyFolioError("FORBIDDEN")).toEqual({ code: "fo_not_found" });
    expect(classifyFolioError("connection reset by peer")).toEqual({ code: "fo_unknown" });
    expect(classifyFolioError("")).toEqual({ code: "fo_unknown" });
  });
  it("never answers with a code outside the folio's own", () => {
    for (const m of ["NOT_FOUND", "INVALID_STATE: x", "POLICY_VIOLATION: nothing we know", "boom", "FORBIDDEN: x", "IDEMPOTENCY_MISMATCH"]) {
      expect(classifyFolioError(m).code, m).toMatch(/^fo_/);
    }
  });
});

describe("words for the folio", () => {
  const codes: ErrorCode[] = [
    "fo_category", "fo_description", "fo_quantity", "fo_amount", "fo_date", "fo_room", "fo_reason", "fo_method", "fo_too_long",
    "fo_overpay", "fo_not_open", "fo_paid", "fo_not_found", "fo_duplicate",
  ];
  it("has a plain sentence for every error code and never echoes raw database text", () => {
    for (const c of codes) {
      const text = errorMessage(c, null, String);
      expect(text, c).not.toMatch(/Something went wrong/);
      expect(text, c).not.toMatch(/P0001|POLICY_VIOLATION|FORBIDDEN|INVALID_STATE|NOT_FOUND/);
    }
  });
  it("falls back to the general sentence for an unexpected failure", () => {
    expect(errorMessage("fo_unknown", null, String)).toMatch(/Something went wrong/);
  });
  it("says how much is outstanding when a payment is too big", () => {
    expect(errorMessage("fo_overpay", 250000, money)).toBe("That is more than the extras still owed. At most N2500 is outstanding.");
    expect(errorMessage("fo_overpay", null, money)).toBe("That is more than the extras still owed.");
  });
  it("has a success sentence for every folio result, and says a reversal pays nothing back", () => {
    for (const c of FOLIO_OK_CODES) expect(OK_MESSAGES[c], c).toBeTruthy();
    expect(OK_MESSAGES.fo_reversed).toMatch(/No money has been paid back/);
  });
});

describe("isFolioResult", () => {
  it("is true for any folio result, success or refusal, and false for everything else", () => {
    expect(isFolioResult({ ok: "fo_posted" })).toBe(true);
    expect(isFolioResult({ err: "fo_overpay", n: "100" })).toBe(true);
    expect(isFolioResult({ err: ["fo_date"] })).toBe(true);
    expect(isFolioResult({ ok: "payment_recorded" })).toBe(false);
    expect(isFolioResult({ err: "overpayment" })).toBe(false);
    expect(isFolioResult({})).toBe(false);
    expect(isFolioResult({ ok: "xfo_posted" })).toBe(false);
  });
});
