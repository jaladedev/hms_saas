import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorMessage, OK_MESSAGES } from "./refunds";
import {
  classifyReceiptError,
  MAX_RECEIPT_BYTES,
  MAX_RECEIPTS,
  RECEIPT_ACCEPT,
  RECEIPT_BUCKET,
  RECEIPT_LINK_SECONDS,
  receiptLabel,
  receiptPath,
  validateReceipt,
} from "./payment-receipts";

const T = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const Y = "33333333-3333-4333-8333-333333333333";
const F = "44444444-4444-4444-8444-444444444444";

describe("validateReceipt", () => {
  it("accepts pictures and PDFs up to the limit, and names the extension", () => {
    expect(validateReceipt({ type: "image/jpeg", size: 1 })).toEqual({ ok: true, contentType: "image/jpeg", ext: "jpg" });
    expect(validateReceipt({ type: "image/png", size: 1000 })).toMatchObject({ ok: true, ext: "png" });
    expect(validateReceipt({ type: "image/webp", size: 1000 })).toMatchObject({ ok: true, ext: "webp" });
    expect(validateReceipt({ type: "application/pdf", size: MAX_RECEIPT_BYTES })).toMatchObject({ ok: true, ext: "pdf" });
  });
  it("refuses an empty file, one over 5 MB, no file, and any other type", () => {
    for (const f of [
      { type: "image/jpeg", size: 0 },
      { type: "image/jpeg", size: MAX_RECEIPT_BYTES + 1 },
      null,
      undefined,
      { type: "image/gif", size: 10 },
      { type: "image/svg+xml", size: 10 },
      { type: "text/html", size: 10 },
      { type: "application/zip", size: 10 },
      { type: "", size: 10 },
    ]) {
      expect(validateReceipt(f), JSON.stringify(f)).toEqual({ ok: false, code: "receipt_file" });
    }
  });
  it("matches what the file box offers and what the bucket allows", () => {
    expect(RECEIPT_ACCEPT.split(",").sort()).toEqual(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
    const sql = readFileSync("supabase/migrations/20261026000178_payment_receipts.sql", "utf8");
    for (const t of RECEIPT_ACCEPT.split(",")) expect(sql).toContain(`'${t}'`);
    expect(sql).toContain(String(MAX_RECEIPT_BYTES));
    expect(sql).toMatch(new RegExp(`>= ${MAX_RECEIPTS} then`));
    expect(MAX_RECEIPTS).toBe(3);
  });
});

describe("receiptPath", () => {
  it("is tenant / property / payment / id . extension, the shape the table checks", () => {
    const path = receiptPath(T, P, Y, F, "pdf");
    expect(path).toBe(`${T}/${P}/${Y}/${F}.pdf`);
    const sql = readFileSync("supabase/migrations/20261026000178_payment_receipts.sql", "utf8");
    expect(sql).toContain("(jpg|png|webp|pdf)");
  });
});

describe("classifyReceiptError", () => {
  it("words each database refusal as a code and never passes text through", () => {
    expect(classifyReceiptError({ message: "POLICY_VIOLATION: receipts limit" })).toBe("receipt_limit");
    expect(classifyReceiptError({ message: "POLICY_VIOLATION: receipt property" })).toBe("receipt_forbidden");
    expect(classifyReceiptError({ code: "42501", message: "x" })).toBe("receipt_forbidden");
    expect(classifyReceiptError({ message: 'new row violates row-level security policy for table "payment_receipts"' })).toBe(
      "receipt_forbidden",
    );
    expect(classifyReceiptError({ code: "23514", message: "check" })).toBe("receipt_file");
    expect(classifyReceiptError({ code: "23505", message: "dup" })).toBe("receipt_file");
    expect(classifyReceiptError({ message: "boom" })).toBe("unknown");
    expect(classifyReceiptError({})).toBe("unknown");
  });
});

describe("receiptLabel", () => {
  it("says what the file is and how big", () => {
    expect(receiptLabel(1, "application/pdf", 340 * 1024)).toBe("Receipt 1, PDF, 340 KB");
    expect(receiptLabel(2, "image/jpeg", 1.5 * 1024 * 1024)).toBe("Receipt 2, picture, 1.5 MB");
  });
});

describe("the messages", () => {
  it("has words for every outcome and never shows database text", () => {
    expect(OK_MESSAGES.receipt_added).toMatch(/added/);
    expect(OK_MESSAGES.receipt_removed).toMatch(/removed/);
    for (const code of ["receipt_file", "receipt_limit", "receipt_forbidden", "receipt_storage"]) {
      const text = errorMessage(code, null, String);
      expect(text.length, code).toBeGreaterThan(15);
      expect(text, code).not.toMatch(/constraint|row-level|undefined|policy/i);
    }
  });
});

// The rules that keep a private file private and a payment untouched are in the actions and the page; these read their source.
describe("receipt actions and page wiring", () => {
  const actions = readFileSync("lib/staff/payment-receipt-actions.ts", "utf8");
  const add = actions.slice(
    actions.indexOf("export async function addPaymentReceipt"),
    actions.indexOf("export async function removePaymentReceipt"),
  );
  const remove = actions.slice(actions.indexOf("export async function removePaymentReceipt"));
  const page = readFileSync("app/(staff)/app/payments/[id]/page.tsx", "utf8");

  it("adding writes the row as the person first, then stores the file, and withdraws the row if storing fails", () => {
    expect(add.indexOf('.from("payment_receipts")\n    .insert(')).toBeGreaterThan(-1);
    expect(add.indexOf("storage")).toBeGreaterThan(add.indexOf(".insert("));
    expect(add).toMatch(/upErr\) \{\s*await supabase\.from\("payment_receipts"\)\.delete\(\)\.eq\("id", row\.id\)/);
  });

  it("removing checks the person may remove BEFORE the file goes, and the file goes before the row", () => {
    const perm = remove.indexOf('"payment.record"');
    const file = remove.indexOf(".remove([row.storage_path])");
    const del = remove.indexOf('.from("payment_receipts").delete()');
    expect(perm).toBeGreaterThan(-1);
    expect(file).toBeGreaterThan(perm);
    expect(del).toBeGreaterThan(file);
  });

  it("never changes a payment: no write to payments, allocations or reservations anywhere in the receipt code", () => {
    for (const src of [actions, readFileSync("lib/staff/payment-receipts.ts", "utf8")]) {
      expect(src).not.toMatch(/from\("(payments|payment_allocations|reservations|invoices)"\)\s*\.(insert|update|delete|upsert)/);
      expect(src).not.toMatch(/\.rpc\("(record_manual_payment|verify_payment|reverse_payment)/);
    }
  });

  it("shows a file only by a short-lived signed link, from a private bucket", () => {
    expect(RECEIPT_BUCKET).toBe("payment-receipts");
    expect(RECEIPT_LINK_SECONDS).toBeLessThanOrEqual(600);
    expect(page).toContain("createSignedUrls(");
    expect(page).not.toContain("getPublicUrl");
    expect(readFileSync("supabase/migrations/20261026000178_payment_receipts.sql", "utf8")).toMatch(
      /values \('payment-receipts', 'payment-receipts', false,/,
    );
  });

  it("opens receipts in a new tab without handing over the opener or the address", () => {
    expect(page).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });

  it("offers adding and removing only to people who may record payments, and only below the limit", () => {
    expect(page).toContain('p_permission: "payment.record"');
    expect(page).toMatch(/canRecord && receipts\.length < MAX_RECEIPTS/);
    expect(page).toMatch(/\{canRecord && \(\s*<form action=\{removePaymentReceipt\}/);
  });
});
