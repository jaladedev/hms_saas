import { describe, expect, it } from "vitest";
import { decimalToMinor, detectUnit, parseCsv, readProviderRows, reconcile, statusOf, type OurPayment, type ProviderRow } from "./reconciliation";

const row = (reference: string, amountText: string, status: ProviderRow["status"] = "success", line = 2, currency: string | null = null): ProviderRow =>
  ({ line, reference, amountText, status, statusText: status, currency });
const pay = (reference: string, amount_minor: number, extra: Partial<OurPayment> = {}): OurPayment =>
  ({ id: `p-${reference}`, reservation_id: `r-${reference}`, reference, amount_minor, currency: "NGN", payment_status: "succeeded", ...extra });

describe("parseCsv", () => {
  it("reads quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a byte order mark", () => {
    const text = '\ufeffa,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"two\nlines",z\r\n';
    expect(parseCsv(text)).toEqual([["a", "b", "c"], ["1", "x, y", 'he said "hi"'], ["2", "two\nlines", "z"]]);
  });
  it("keeps empty fields and ignores blank lines and a missing final newline", () => {
    expect(parseCsv("a,b\n\n1,\n,2")).toEqual([["a", "b"], ["1", ""], ["", "2"]]);
  });
  it("refuses a file that ends inside a quote", () => {
    expect(() => parseCsv('a,b\n1,"oops')).toThrow(/quoted/);
  });
});

describe("statusOf", () => {
  it("maps the words Paystack uses and treats anything else as other", () => {
    expect(["success", "Successful", " FAILED ", "abandoned", "reversed", "ongoing", ""].map(statusOf))
      .toEqual(["success", "success", "failed", "abandoned", "reversed", "other", "other"]);
  });
});

describe("readProviderRows", () => {
  it("finds the columns by header name, whatever the order, case or extra columns", () => {
    const r = readProviderRows("Paid At,Status,Transaction Reference,Amount (NGN),Currency,Email\n2026-11-03,success,HMS-1,\"1,500.50\",ngn,a@b.c\n");
    expect(r.fatal).toBe(false);
    expect(r.columns).toEqual({ reference: "Transaction Reference", amount: "Amount (NGN)", status: "Status", currency: "Currency" });
    expect(r.rows).toEqual([{ line: 2, reference: "HMS-1", amountText: "1,500.50", status: "success", statusText: "success", currency: "NGN" }]);
  });
  it("stops and names what is missing and what was found", () => {
    const r = readProviderRows("Paid At,Email\n2026-11-03,a@b.c\n");
    expect(r.fatal).toBe(true);
    expect(r.problems[0]).toMatch(/no reference, amount, status column/);
    expect(r.problems[0]).toMatch(/Paid At, Email/);
  });
  it("skips rows without a reference and says how many", () => {
    const r = readProviderRows("reference,amount,status\nA,1,success\n,2,success\n");
    expect(r.rows.map((x) => x.reference)).toEqual(["A"]);
    expect(r.problems).toEqual(["1 row has no reference and was skipped."]);
  });
  it("reports an empty file and a broken one", () => {
    expect(readProviderRows("").fatal).toBe(true);
    expect(readProviderRows('reference,amount,status\n"x').fatal).toBe(true);
  });
  it("has no currency column without failing", () => {
    expect(readProviderRows("reference,amount,status\nA,1,success\n").rows[0]!.currency).toBeNull();
  });
});

describe("decimalToMinor", () => {
  it("reads naira to exact kobo without floating point", () => {
    expect(decimalToMinor("1500", "naira")).toBe(150000);
    expect(decimalToMinor("1,500.5", "naira")).toBe(150050);
    expect(decimalToMinor("₦0.07", "naira")).toBe(7);
    expect(decimalToMinor("NGN 19.99", "naira")).toBe(1999);
    expect(decimalToMinor("0.10", "naira")).toBe(10);
    expect(decimalToMinor("12.500", "naira")).toBe(1250);
  });
  it("rejects anything that is not a plain amount", () => {
    for (const bad of ["", "abc", "-5", "1.005", "1.2.3", "1e3", "12 000", "--"]) expect(decimalToMinor(bad, "naira")).toBeNull();
  });
  it("reads kobo as whole numbers, allowing a trailing .00", () => {
    expect(decimalToMinor("150050", "kobo")).toBe(150050);
    expect(decimalToMinor("150050.00", "kobo")).toBe(150050);
    expect(decimalToMinor("150050.5", "kobo")).toBeNull();
  });
});

describe("detectUnit", () => {
  const ours = [pay("A", 150050), pay("B", 20000)];
  it("picks the unit under which more successful rows agree with our records", () => {
    expect(detectUnit([row("A", "1500.50"), row("B", "200")], ours)).toMatchObject({ unit: "naira", naira: 2, kobo: 0 });
    expect(detectUnit([row("A", "150050"), row("B", "20000")], ours)).toMatchObject({ unit: "kobo", naira: 0, kobo: 2 });
  });
  it("cannot tell when no reference is on both sides, or the readings tie", () => {
    expect(detectUnit([row("Z", "1")], ours).unit).toBeNull();
    expect(detectUnit([row("A", "nonsense")], ours).unit).toBeNull();
  });
  it("ignores rows that were not successful", () => {
    expect(detectUnit([row("A", "1500.50", "failed")], ours).unit).toBeNull();
  });
});

describe("reconcile", () => {
  it("matches the same reference, amount and currency", () => {
    const r = reconcile([row("A", "1500.50", "success", 2, "NGN")], [pay("A", 150050)], "naira");
    expect(r).toMatchObject({ fileRows: 1, matched: 1, matchedMinor: 150050, ignored: 0, findings: [] });
  });

  it("finds money Paystack has that we do not show (a missed webhook)", () => {
    const r = reconcile([row("A", "200")], [], "naira");
    expect(r.findings).toEqual([{ kind: "missing_here", reference: "A", line: 2, providerMinor: 20000, currency: null }]);
  });

  it("finds a different amount and a different currency", () => {
    const r = reconcile([row("A", "199"), row("B", "5", "success", 3, "USD")], [pay("A", 20000), pay("B", 500)], "naira");
    expect(r.findings.map((f) => f.kind)).toEqual(["amount_differs", "currency_differs"]);
    expect(r.findings[0]).toMatchObject({ providerMinor: 19900, ourMinor: 20000, reservationId: "r-A" });
    expect(r.findings[1]).toMatchObject({ providerCurrency: "USD", ourCurrency: "NGN" });
  });

  it("flags a payment we hold that Paystack did not succeed, and one it reversed", () => {
    const r = reconcile([row("A", "200", "failed"), row("B", "200", "reversed", 3), row("C", "200", "abandoned", 4)], [pay("A", 20000), pay("B", 20000)], "naira");
    expect(r.findings.map((f) => `${f.kind}:${f.reference}`)).toEqual(["not_successful_at_provider:A", "reversed_at_provider:B"]);
    expect(r.ignored).toBe(1);
  });

  it("flags a payment we reversed that Paystack still shows as successful", () => {
    const r = reconcile([row("A", "200")], [pay("A", 20000, { payment_status: "reversed" })], "naira");
    expect(r.findings.map((f) => f.kind)).toEqual(["reversed_here"]);
  });

  it("lists payments that are not in the file, but not ones we already reversed", () => {
    const r = reconcile([row("A", "200")], [pay("A", 20000), pay("B", 5000), pay("C", 100, { payment_status: "reversed" })], "naira");
    expect(r.findings).toEqual([{ kind: "not_in_file", reference: "B", ourMinor: 5000, paymentId: "p-B", reservationId: "r-B" }]);
  });

  it("reports an unreadable amount and a reference listed twice, using the first line only", () => {
    const r = reconcile([row("A", "oops", "success", 2), row("B", "200", "success", 3), row("B", "300", "success", 4)], [pay("B", 20000)], "naira");
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["bad_amount", "duplicate_in_file"]);
    expect(r.findings.find((f) => f.kind === "duplicate_in_file")).toMatchObject({ lines: [3, 4] });
    expect(r.matched).toBe(1);
  });

  it("ignores failed or abandoned rows that we never recorded", () => {
    const r = reconcile([row("A", "200", "failed"), row("B", "200", "abandoned", 3)], [], "naira");
    expect(r).toMatchObject({ matched: 0, ignored: 2, findings: [] });
  });

  it("orders findings most serious first, then by reference", () => {
    const r = reconcile([row("Z", "1"), row("A", "1")], [pay("M", 100)], "naira");
    expect(r.findings.map((f) => `${f.kind}:${f.reference}`)).toEqual(["missing_here:A", "missing_here:Z", "not_in_file:M"]);
  });
});
