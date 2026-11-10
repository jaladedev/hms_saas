export type PaymentToVerify = {
  id: string;
  property_id: string;
  property_name: string;
  reservation_id: string;
  booking_reference: string;
  guest_name: string | null;
  amount_minor: number;
  currency: string;
  method: string;
  reference: string | null;
  note: string | null;
  received_at: string;
  recorded_by_name: string | null;
  verification_status: "verified" | "unverified";
  verified_at: string | null;
  verified_by_name: string | null;
  verification_note: string | null;
};
export type VerificationQueue = { items: PaymentToVerify[]; unverified: number };

export const METHOD_LABEL: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", pos: "POS", other: "Other" };
export const methodLabel = (m: string) => METHOD_LABEL[m] ?? m;

/** Which list to show: the queue by default, or the recently verified ones. */
export function parseVerificationView(v: string | string[] | undefined): "unverified" | "verified" {
  return (Array.isArray(v) ? v[0] : v) === "verified" ? "verified" : "unverified";
}

/** The queue as the database returns it, with malformed rows dropped. */
export function parseQueue(data: unknown): VerificationQueue {
  const d = (data ?? {}) as { items?: unknown; unverified?: unknown };
  const items = Array.isArray(d.items)
    ? (d.items as PaymentToVerify[]).filter(
        (i) => i && typeof i.id === "string" && typeof i.amount_minor === "number" && typeof i.reservation_id === "string",
      )
    : [];
  return { items, unverified: typeof d.unverified === "number" && d.unverified > 0 ? d.unverified : 0 };
}

/** Whole days a payment has waited, for "waiting 3 days"; never negative, and zero for a bad date. */
export function daysWaiting(receivedAt: string, now: Date): number {
  const t = new Date(receivedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

export function waitingText(days: number): string {
  return days === 0 ? "recorded today" : days === 1 ? "waiting 1 day" : `waiting ${days} days`;
}
