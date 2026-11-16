import { parseNairaToKobo } from "@/lib/platform/hotel";

export const MAX_EXPERIENCES = 12;
export const MAX_EXPERIENCE_NAME = 60;
export const MAX_EXPERIENCE_BODY = 200;

export type ExperienceUnit = "person" | "booking";
export type ExperienceForm = {
  propertyId: string;
  experienceId: string | null;
  name: string;
  body: string;
  priceMinor: number;
  unit: ExperienceUnit;
  active: boolean;
  sort: number;
};
export type ExperienceCheck = { ok: true; value: ExperienceForm } | { ok: false; code: "experience_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Reads the experience form (price typed in naira). The database checks again and decides who may save. */
export function parseExperienceForm(raw: Record<string, unknown>): ExperienceCheck {
  const bad = { ok: false, code: "experience_invalid" } as const;
  const propertyId = text(raw.propertyId);
  const experienceId = text(raw.experienceId);
  const name = text(raw.name);
  const body = text(raw.body);
  const unit = text(raw.unit) || "person";
  const sortRaw = text(raw.sort);
  if (!UUID.test(propertyId) || (experienceId !== "" && !UUID.test(experienceId))) return bad;
  if (name.length < 1 || name.length > MAX_EXPERIENCE_NAME || body.length > MAX_EXPERIENCE_BODY) return bad;
  if (unit !== "person" && unit !== "booking") return bad;
  const priceMinor = parseNairaToKobo(text(raw.price));
  if (priceMinor === null || priceMinor < 1 || priceMinor > 1_000_000_000) return bad;
  const sort = sortRaw === "" ? 0 : Number(sortRaw);
  if (!Number.isInteger(sort) || sort < -1000 || sort > 1000) return bad;
  return {
    ok: true,
    value: {
      propertyId,
      experienceId: experienceId === "" ? null : experienceId,
      name,
      body,
      priceMinor,
      unit,
      active: raw.active === "on" || raw.active === "true",
      sort,
    },
  };
}

export type OpenExperienceRequest = {
  id: string;
  reservation_id: string;
  booking_reference: string;
  name: string;
  quantity: number;
  date: string | null;
  note: string | null;
  status: "requested" | "confirmed";
  total_minor: number;
  reservation_status: string;
  arrival_date: string;
  departure_date: string;
};

/** Reads the queue the database returns, dropping anything that is not shaped like a request. */
export function parseOpenRequests(data: unknown): OpenExperienceRequest[] {
  const list = (data as { requests?: unknown } | null)?.requests;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is OpenExperienceRequest => {
    const o = r as Partial<OpenExperienceRequest> | null;
    return (
      !!o &&
      typeof o.id === "string" &&
      typeof o.name === "string" &&
      typeof o.quantity === "number" &&
      typeof o.total_minor === "number" &&
      (o.status === "requested" || o.status === "confirmed")
    );
  });
}

/** Whether the "Post to folio" step can work now: the guest has to be checked in or have left. */
export function canPostToFolio(reservationStatus: string): boolean {
  return reservationStatus === "checked_in" || reservationStatus === "checked_out";
}

/** "per person" or "per booking", for the price line. */
export function unitLabel(unit: string): string {
  return unit === "booking" ? "per booking" : "per person";
}
