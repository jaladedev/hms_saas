export const MAX_EXPERIENCE_NOTE = 200;

export type ExperienceRequestInput = { experienceId: string; quantity: number; date: string | null; note: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the request form: an experience id, a whole number of 1 to 20, an optional day and an optional note of at most 200 characters. */
export function parseExperienceRequest(
  raw: Record<string, unknown>,
): ExperienceRequestInput | { error: "bad_request" | "experience_quantity" | "experience_date" | "experience_note" } {
  const id = typeof raw.experienceId === "string" ? raw.experienceId.trim() : "";
  if (!UUID.test(id)) return { error: "bad_request" };
  const q = typeof raw.quantity === "string" ? raw.quantity.trim() : "";
  if (!/^\d{1,2}$/.test(q) || Number(q) < 1 || Number(q) > 20) return { error: "experience_quantity" };
  const d = typeof raw.date === "string" ? raw.date.trim() : "";
  if (d !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: "experience_date" };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (Array.from(note).length > MAX_EXPERIENCE_NOTE) return { error: "experience_note" };
  return { experienceId: id, quantity: Number(q), date: d === "" ? null : d, note };
}

/** "per person" or "per booking" after a price. */
export function experienceUnit(unit: string): string {
  return unit === "booking" ? "per booking" : "per person";
}

/** What a guest reads for a request's state. */
export function requestStatusLabel(status: string): string {
  switch (status) {
    case "confirmed":
      return "Confirmed by the hotel";
    case "declined":
      return "The hotel could not offer this";
    case "charged":
      return "Added to your bill";
    default:
      return "Waiting for the hotel";
  }
}
