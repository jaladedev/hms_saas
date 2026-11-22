import { formatBytes } from "./room-photos";

/**
 * Receipts on a recorded payment (migration 178): the rules for the file, and the storage path the database check expects.
 * Pure helpers, so they can be tested without a browser or storage. The database enforces the same limits.
 */

export const RECEIPT_BUCKET = "payment-receipts";
export const MAX_RECEIPTS = 3;
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
/** How long a link to a receipt stays valid. It is made when the page is shown, for someone who may see the payment. */
export const RECEIPT_LINK_SECONDS = 300;
/** For the file box: what the browser offers to pick. The server still decides. */
export const RECEIPT_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

const TYPES: Record<string, "jpg" | "png" | "webp" | "pdf"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export type ReceiptCheck = { ok: true; contentType: string; ext: "jpg" | "png" | "webp" | "pdf" } | { ok: false; code: "receipt_file" };

/** Checks the chosen file's type and size. The type is the one the browser reports; storage checks it again against the bucket's list. */
export function validateReceipt(file: { type: string; size: number } | null | undefined): ReceiptCheck {
  if (!file || file.size <= 0 || file.size > MAX_RECEIPT_BYTES) return { ok: false, code: "receipt_file" };
  const ext = TYPES[file.type];
  return ext ? { ok: true, contentType: file.type, ext } : { ok: false, code: "receipt_file" };
}

/** The storage path the database check expects: tenant / property / payment / unique id . extension. */
export function receiptPath(tenantId: string, propertyId: string, paymentId: string, id: string, ext: string): string {
  return `${tenantId}/${propertyId}/${paymentId}/${id}.${ext}`;
}

/** Turns a database refusal on a receipt into one of our codes. Raw database text never reaches the page. */
export function classifyReceiptError(err: {
  code?: string;
  message?: string;
}): "receipt_limit" | "receipt_forbidden" | "receipt_file" | "unknown" {
  const msg = err.message ?? "";
  if (/receipts limit/i.test(msg)) return "receipt_limit";
  if (/receipt property/i.test(msg) || err.code === "42501" || /row-level security/i.test(msg)) return "receipt_forbidden";
  if (err.code === "23514" || err.code === "23505") return "receipt_file";
  return "unknown";
}

/** "Receipt 2, PDF, 340 KB": what to call a file in a list. */
export function receiptLabel(position: number, contentType: string, sizeBytes: number): string {
  return `Receipt ${position}, ${contentType === "application/pdf" ? "PDF" : "picture"}, ${formatBytes(sizeBytes)}`;
}
