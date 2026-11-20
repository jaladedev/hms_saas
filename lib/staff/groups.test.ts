import { describe, expect, it } from "vitest";
import {
  classifyGroupError,
  heldSummary,
  parseGroupStatement,
  parseGroupInvoices,
  parseIssueInvoiceForm,
  parsePaidInvoiceForm,
  parseCompanies,
  parseCompanyCreateForm,
  parseGroupPayments,
  parseGroupPaymentForm,
  parseLinkForm,
  parseOverdue,
  suggestedDueDate,
  parseCreateGroupForm,
  parseGroupDetail,
  parseGroupList,
  parseRoomingForm,
  parseUpdateGroupForm,
} from "./groups";

const P = "00000000-0000-0000-0000-0000000000a2";
const T1 = "00000000-0000-0000-0000-0000000000a3";
const T2 = "00000000-0000-0000-0000-0000000000a4";
const base = {
  propertyId: P,
  name: "Wedding",
  contactName: "Ada Obi",
  arrival: "2027-05-10",
  departure: "2027-05-13",
  release: "2027-05-01",
  key: "abcdefgh12",
  [`qty_${T1}`]: "3",
};

describe("parseCreateGroupForm", () => {
  it("reads a good form and keeps only the room types asked for", () => {
    const r = parseCreateGroupForm({ ...base, [`qty_${T2}`]: "", company: " Acme ", contactEmail: "a@b.co" });
    expect(r.ok && r.value.rooms).toEqual([{ room_type_id: T1, quantity: 3 }]);
    expect(r.ok && r.value.company).toBe("Acme");
  });
  it("refuses a release date after arrival, long stays, bad dates and no rooms", () => {
    expect(parseCreateGroupForm({ ...base, release: "2027-05-11" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, departure: "2027-07-20" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, arrival: "2027-02-30" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, [`qty_${T1}`]: "0" }).ok).toBe(false);
  });
  it("refuses too many rooms, a bad email and a missing name", () => {
    expect(parseCreateGroupForm({ ...base, [`qty_${T1}`]: "51" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, [`qty_${T1}`]: "50", [`qty_${T2}`]: "50", qty_x: "" }).ok).toBe(true);
    expect(
      parseCreateGroupForm({ ...base, [`qty_${T1}`]: "50", [`qty_${T2}`]: "50", [`qty_00000000-0000-0000-0000-0000000000a5`]: "1" }).ok,
    ).toBe(false);
    expect(parseCreateGroupForm({ ...base, contactEmail: "nope" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, name: " " }).ok).toBe(false);
  });
});

describe("other forms", () => {
  it("checks the update and rooming forms", () => {
    expect(parseUpdateGroupForm({ groupId: P, contactName: "Ada", release: "2027-05-02" }).ok).toBe(true);
    expect(parseUpdateGroupForm({ groupId: P, contactName: "", release: "2027-05-02" }).ok).toBe(false);
    expect(parseRoomingForm({ groupId: P, guest: "Chidi", roomTypeId: "" }).ok).toBe(true);
    expect(parseRoomingForm({ groupId: P, guest: "", roomTypeId: "" }).ok).toBe(false);
    expect(parseRoomingForm({ groupId: P, guest: "Chidi", roomTypeId: "zzz" }).ok).toBe(false);
  });
});

describe("classifyGroupError", () => {
  it("maps refusals to codes", () => {
    expect(classifyGroupError("NOT_FOUND")).toBe("group_forbidden");
    expect(classifyGroupError("POLICY_VIOLATION: ROOMS_UNAVAILABLE")).toBe("group_unavailable");
    expect(classifyGroupError("POLICY_VIOLATION: group bookings off")).toBe("group_off");
    expect(classifyGroupError("INVALID_STATE: cancelled")).toBe("group_closed");
    expect(classifyGroupError("POLICY_VIOLATION: dates")).toBe("group_invalid");
    expect(classifyGroupError("boom")).toBe("group_failed");
  });
});

describe("reading", () => {
  it("reads the list and detail and ignores junk", () => {
    expect(parseGroupList("x")).toEqual([]);
    const l = parseGroupList([{ id: "g1", name: "W", contact_name: "A", status: "weird", rooms_total: 4, rooms_held: "3" }]);
    expect(l[0]).toMatchObject({ status: "open", roomsTotal: 4, roomsHeld: 3 });
    const d = parseGroupDetail({
      id: "g1",
      rooms: [
        { room_type_id: T1, room_type_name: "Standard", held: 2, used: 1, released: 0 },
        { room_type_name: "Deluxe", held: 0 },
      ],
      rooming: [],
    });
    expect(d && heldSummary(d.rooms)).toBe("2 Standard");
    expect(parseGroupDetail(null)).toBeNull();
  });
});

describe("step two", () => {
  it("checks the link form and maps its refusals", () => {
    expect(parseLinkForm({ groupId: P, entryId: T1, reference: "HMS-1234" }).ok).toBe(true);
    expect(parseLinkForm({ groupId: P, entryId: T1, reference: "x" }).ok).toBe(false);
    expect(classifyGroupError("POLICY_VIOLATION: booking not found")).toBe("group_booking_missing");
    expect(classifyGroupError("POLICY_VIOLATION: booking dates")).toBe("group_booking_dates");
    expect(classifyGroupError("POLICY_VIOLATION: already linked")).toBe("group_booking_taken");
  });
  it("reads a statement with and without money", () => {
    const hidden = parseGroupStatement({
      money_visible: false,
      bookings: [{ entry_id: "e", guest_name: "A", total_minor: null }],
      total_minor: null,
    });
    expect(hidden?.moneyVisible).toBe(false);
    expect(hidden?.bookings[0]?.totalMinor).toBeNull();
    const shown = parseGroupStatement({ money_visible: true, currency: "NGN", total_minor: 500000, extras_minor: 0, bookings: [] });
    expect(shown).toMatchObject({ moneyVisible: true, totalMinor: 500000, extrasMinor: 0 });
    expect(parseGroupStatement("x")).toBeNull();
  });
});

describe("step three", () => {
  it("checks the invoice forms and maps refusals", () => {
    expect(parseIssueInvoiceForm({ groupId: P, due: "2027-01-31", key: "abcdefgh12" }).ok).toBe(true);
    expect(parseIssueInvoiceForm({ groupId: P, due: "2027-02-31", key: "abcdefgh12" }).ok).toBe(false);
    expect(parsePaidInvoiceForm({ groupId: P, invoiceId: T1, method: "cheque" }).ok).toBe(false);
    expect(parsePaidInvoiceForm({ groupId: P, invoiceId: T1, method: "cash", reference: "R1" }).ok).toBe(true);
    expect(classifyGroupError("INVALID_STATE: nothing to invoice")).toBe("group_nothing_to_invoice");
    expect(classifyGroupError("INVALID_STATE: paid")).toBe("group_invoice_final");
    expect(classifyGroupError("POLICY_VIOLATION: due date")).toBe("group_due_date");
  });
  it("reads invoices", () => {
    const [i] = parseGroupInvoices([
      {
        id: "i1",
        invoice_number: "INV-X-2026-000001",
        status: "paid",
        total_minor: 100,
        lines: [{ booking_reference: "B1", line_total_minor: 100 }],
      },
    ]);
    expect(i).toMatchObject({ status: "paid", totalMinor: 100 });
    expect(i?.lines[0]?.reference).toBe("B1");
    expect(parseGroupInvoices("x")).toEqual([]);
  });
});

describe("step four", () => {
  const co = { propertyId: P, name: "Globex", contact: "Tola", creditDays: "30", percent: "12.5" };
  it("checks company forms", () => {
    expect(parseCompanyCreateForm(co).ok).toBe(true);
    expect(parseCompanyCreateForm({ ...co, percent: "51" }).ok).toBe(false);
    expect(parseCompanyCreateForm({ ...co, percent: "12.555" }).ok).toBe(false);
    expect(parseCompanyCreateForm({ ...co, creditDays: "91" }).ok).toBe(false);
    expect(parseCompanyCreateForm({ ...co, email: "nope" }).ok).toBe(false);
    expect(parseCompanyCreateForm({ ...co, name: "" }).ok).toBe(false);
  });
  it("maps refusals, reads accounts and suggests a due date", () => {
    expect(classifyGroupError("POLICY_VIOLATION: name taken")).toBe("company_taken");
    expect(classifyGroupError("POLICY_VIOLATION: company")).toBe("group_company_missing");
    expect(classifyGroupError("POLICY_VIOLATION: no company rate")).toBe("group_no_rate");
    expect(parseCompanies([{ id: "c1", name: "G", discount_percent: "12.50", status: "archived" }])[0]).toMatchObject({
      percent: 12.5,
      status: "archived",
    });
    expect(suggestedDueDate("2026-12-20", 30)).toBe("2027-01-19");
    expect(suggestedDueDate("2026-12-20", 500)).toBe("2027-03-20");
  });
});

describe("step six", () => {
  const pay = { groupId: P, method: "bank_transfer", key: "abcdefgh12", amount: "150,000.50" };
  it("reads the amount, or the shares when there are any", () => {
    const a = parseGroupPaymentForm(pay);
    expect(a.ok && a.value).toMatchObject({ amountMinor: 15000050, allocations: null });
    const s = parseGroupPaymentForm({ ...pay, amount: "1", [`share_${T1}`]: "1,000", [`share_${T2}`]: "500.50" });
    expect(s.ok && s.value.amountMinor).toBe(150050);
    expect(s.ok && s.value.allocations).toHaveLength(2);
  });
  it("refuses bad payments and maps refusals", () => {
    expect(parseGroupPaymentForm({ ...pay, amount: "0" }).ok).toBe(false);
    expect(parseGroupPaymentForm({ ...pay, amount: "" }).ok).toBe(false);
    expect(parseGroupPaymentForm({ ...pay, method: "cheque" }).ok).toBe(false);
    expect(parseGroupPaymentForm({ ...pay, [`share_${T1}`]: "abc" }).ok).toBe(false);
    expect(classifyGroupError("POLICY_VIOLATION: exceeds outstanding")).toBe("group_pay_exceeds");
    expect(classifyGroupError("POLICY_VIOLATION: OVERPAYMENT outstanding 5")).toBe("group_pay_overpay");
    expect(classifyGroupError("POLICY_VIOLATION: allocation total")).toBe("group_pay_alloc");
    expect(classifyGroupError("INVALID_STATE: reversed")).toBe("group_pay_reversed");
  });
  it("reads payments", () => {
    const [p] = parseGroupPayments([
      {
        id: "p1",
        amount_minor: 100,
        state: "partly_reversed",
        lines: [{ reservation_id: "r", booking_reference: "B", amount_minor: 100 }],
      },
    ]);
    expect(p).toMatchObject({ state: "partly_reversed", amountMinor: 100 });
    expect(p?.lines[0]?.reference).toBe("B");
  });
});

describe("step seven", () => {
  const co = { propertyId: P, name: "Globex", contact: "Tola", creditDays: "30", percent: "0" };
  it("reads an optional credit limit in naira", () => {
    const a = parseCompanyCreateForm({ ...co, creditLimit: "5,000,000" });
    expect(a.ok && a.value.creditLimitMinor).toBe(500000000);
    const b = parseCompanyCreateForm({ ...co, creditLimit: "" });
    expect(b.ok && b.value.creditLimitMinor).toBeNull();
    expect(parseCompanyCreateForm({ ...co, creditLimit: "abc" }).ok).toBe(false);
    expect(parseCompanyCreateForm({ ...co, creditLimit: "0" }).ok).toBe(false);
  });
  it("maps the refusal and reads companies and the overdue list", () => {
    expect(classifyGroupError("POLICY_VIOLATION: credit limit 0")).toBe("group_credit_limit");
    const [c] = parseCompanies([{ id: "c1", name: "G", credit_limit_minor: 1000, exposure_minor: 400, overdue_minor: 100 }]);
    expect(c).toMatchObject({ creditLimitMinor: 1000, exposureMinor: 400, overdueMinor: 100 });
    expect(parseCompanies([{ id: "c2", name: "H" }])[0]?.creditLimitMinor).toBeNull();
    const [o] = parseOverdue([{ invoice_id: "i1", invoice_number: "INV-X", group_name: "W", total_minor: 50, days_overdue: 4 }]);
    expect(o).toMatchObject({ daysOverdue: 4, totalMinor: 50 });
  });
});
