/** Words and rules for the guest cancel page. Pure, so it can be tested. The database decides again on every cancel. */
import type { CancelPreview } from "./server";

const money = (minor: number, f: (m: number, c: string) => string, currency: string) => f(minor, currency);

export type CancelSummary = {
  headline: string;
  lines: string[];
};

/** What cancelling means, in plain sentences, for the amounts the preview gave. */
export function cancelSummary(p: CancelPreview, format: (minor: number, currency: string) => string): CancelSummary {
  const m = (n: number) => money(n, format, p.currency);
  const lines: string[] = [];
  let headline: string;
  if (p.charge_minor === 0) {
    headline = "You can cancel for free.";
  } else {
    headline = `Cancelling now costs ${m(p.charge_minor)}.`;
    lines.push("This is the hotel's cancellation charge for the time left before your arrival.");
  }
  if (p.refund_minor > 0) {
    lines.push(`You paid ${m(p.held_minor)}, so ${m(p.refund_minor)} will be refunded. The hotel approves and sends refunds, and you will get an email when it is processed.`);
  } else if (p.still_owed_minor > 0) {
    lines.push(`You have paid ${m(p.held_minor)}, so ${m(p.still_owed_minor)} would still be owed. The hotel will contact you about it.`);
  } else if (p.held_minor > 0) {
    lines.push("The money you paid covers the charge, so nothing is refunded.");
  }
  lines.push("The rooms are released straight away and this cannot be undone.");
  return { headline, lines };
}

/** The sentence for a booking that cannot be cancelled online, by the reason the database gave. */
export function notAllowedText(why: CancelPreview["why_not"]): string {
  switch (why) {
    case "too_late": return "It is too late to cancel online because check-in time has passed. Please contact the hotel.";
    case "disabled": return "This hotel does not take cancellations online. Please contact the hotel to cancel.";
    case "started": return "This stay has already started, so it cannot be cancelled online. Please contact the hotel.";
    case "status": return "This booking cannot be cancelled online. If it is a hold that has not been paid, it will release itself when the time runs out.";
    default: return "This booking cannot be cancelled online. Please contact the hotel.";
  }
}

/** The charge the guest agreed to, as whole kobo, or null if the form value is not one. */
export function parseExpectedCharge(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,12}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}
