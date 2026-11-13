/**
 * The hotel's arrival reminder setting (migration 122): how many days before arrival a confirmed guest is emailed once.
 * Off by default. Pure functions so they can be tested; the database checks the same range again.
 */
export const REMINDER_DAY_CHOICES = [1, 2, 3, 5, 7] as const;

export type ReminderForm = { propertyId: string; days: number | null };
export type ReminderCheck = { ok: true; value: ReminderForm } | { ok: false; code: "setup_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "" or "off" means no reminders; otherwise a whole number of days from 1 to 7. */
export function parseReminderForm(raw: Record<string, unknown>): ReminderCheck {
  const propertyId = typeof raw.propertyId === "string" ? raw.propertyId.trim() : "";
  if (!UUID.test(propertyId)) return { ok: false, code: "setup_invalid" };
  if (typeof raw.days !== "string") return { ok: false, code: "setup_invalid" };
  const d = raw.days.trim().toLowerCase();
  if (d === "" || d === "off") return { ok: true, value: { propertyId, days: null } };
  if (!/^[0-9]$/.test(d)) return { ok: false, code: "setup_invalid" };
  const days = Number(d);
  if (days < 1 || days > 7) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { propertyId, days } };
}

/** The sentence under the setting: what it does now. */
export function reminderSummary(days: number | null): string {
  if (days === null) return "Guests are not sent a reminder before they arrive.";
  return days === 1
    ? "Each confirmed guest is sent one reminder the day before they arrive."
    : `Each confirmed guest is sent one reminder when they are ${days} days or fewer from arriving.`;
}
