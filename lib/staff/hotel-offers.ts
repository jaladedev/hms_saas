export const MAX_OFFERS = 12;
export const MAX_TITLE = 80;
export const MAX_BODY = 300;
export const MAX_BADGE = 24;

export type OfferForm = {
  propertyId: string;
  offerId: string | null;
  title: string;
  body: string;
  badge: string;
  validFrom: string;
  validTo: string;
  active: boolean;
  sort: number;
};
export type OfferCheck = { ok: true; value: OfferForm } | { ok: false; code: "offer_invalid" | "offer_dates" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function realDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Reads the offer form. Empty dates mean "no limit". The database checks again (and decides who may save); this only keeps obviously
 * wrong input from making the trip and gives the person a plain message for it.
 */
export function parseOfferForm(raw: Record<string, unknown>): OfferCheck {
  const propertyId = text(raw.propertyId);
  const offerId = text(raw.offerId);
  const title = text(raw.title);
  const body = text(raw.body);
  const badge = text(raw.badge);
  const validFrom = text(raw.validFrom);
  const validTo = text(raw.validTo);
  const sortRaw = text(raw.sort);
  if (!UUID.test(propertyId) || (offerId !== "" && !UUID.test(offerId))) return { ok: false, code: "offer_invalid" };
  if (title.length < 1 || title.length > MAX_TITLE || body.length > MAX_BODY || badge.length > MAX_BADGE)
    return { ok: false, code: "offer_invalid" };
  if ((validFrom !== "" && !realDate(validFrom)) || (validTo !== "" && !realDate(validTo))) return { ok: false, code: "offer_dates" };
  if (validFrom !== "" && validTo !== "" && validTo < validFrom) return { ok: false, code: "offer_dates" };
  const sort = sortRaw === "" ? 0 : Number(sortRaw);
  if (!Number.isInteger(sort) || sort < -1000 || sort > 1000) return { ok: false, code: "offer_invalid" };
  return {
    ok: true,
    value: {
      propertyId,
      offerId: offerId === "" ? null : offerId,
      title,
      body,
      badge,
      validFrom,
      validTo,
      active: raw.active === "on" || raw.active === "true",
      sort,
    },
  };
}

/** "Always", "From 1 Dec", "Until 31 Dec" or "1 Dec to 31 Dec", for the staff list. Dates are shown as written (yyyy-mm-dd). */
export function offerWindow(validFrom: string | null, validTo: string | null): string {
  if (validFrom && validTo) return `${validFrom} to ${validTo}`;
  if (validFrom) return `From ${validFrom}`;
  if (validTo) return `Until ${validTo}`;
  return "Always";
}
