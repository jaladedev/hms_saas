/**
 * The hotel's text message settings (migration 147). Pure functions so they can be tested; the database checks the same ranges again.
 * Texts are off until a person with property.configure turns them on, and only when the hotel group's plan includes them.
 */
export const SMS_KIND_CHOICES = [
  { key: "booking_confirmed", label: "Booking confirmed", help: "Sent when a website booking is paid and confirmed." },
  { key: "arrival_reminder", label: "Arrival reminder", help: "Sent once, a few days (set below) before arrival." },
  {
    key: "review_request",
    label: "Review request",
    help: "Sent a couple of hours after check-out, for stays that ended in the last 14 days.",
  },
] as const;
export type SmsKindKey = (typeof SMS_KIND_CHOICES)[number]["key"];

export const SMS_CHANNELS = ["sms", "whatsapp"] as const;
export const SMS_REMINDER_DAYS = [1, 2, 3, 5, 7] as const;
export const MAX_SMS_CAP = 100000;

export type SmsForm = {
  propertyId: string;
  enabled: boolean;
  kinds: SmsKindKey[];
  channel: "sms" | "whatsapp";
  monthlyCap: number;
  reminderDays: number;
};
export type SmsCheck = { ok: true; value: SmsForm } | { ok: false; code: "sms_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSmsForm(raw: {
  propertyId?: unknown;
  enabled?: unknown;
  kinds?: unknown;
  channel?: unknown;
  monthlyCap?: unknown;
  reminderDays?: unknown;
}): SmsCheck {
  const bad = { ok: false, code: "sms_invalid" } as const;
  const propertyId = typeof raw.propertyId === "string" ? raw.propertyId.trim() : "";
  if (!UUID.test(propertyId)) return bad;
  const allowed: string[] = SMS_KIND_CHOICES.map((k) => k.key);
  const given = Array.isArray(raw.kinds) ? raw.kinds : [];
  if (!given.every((k) => typeof k === "string" && allowed.includes(k))) return bad;
  const kinds = allowed.filter((k) => given.includes(k)) as SmsKindKey[];
  const channel = typeof raw.channel === "string" ? raw.channel.trim() : "sms";
  if (channel !== "sms" && channel !== "whatsapp") return bad;
  const cap = typeof raw.monthlyCap === "string" ? raw.monthlyCap.trim() : "";
  if (!/^\d{1,6}$/.test(cap) || Number(cap) > MAX_SMS_CAP) return bad;
  const days = typeof raw.reminderDays === "string" ? raw.reminderDays.trim() : "";
  if (!/^[1-7]$/.test(days)) return bad;
  return {
    ok: true,
    value: { propertyId, enabled: raw.enabled === "on", kinds, channel, monthlyCap: Number(cap), reminderDays: Number(days) },
  };
}

/** The sentence under the switch: what happens now. */
export function smsSummary(enabled: boolean, kinds: readonly string[], cap: number): string {
  if (!enabled) return "Guests are not sent text messages.";
  if (kinds.length === 0) return "Texts are on, but no kind of message is selected, so nothing is sent.";
  const names = SMS_KIND_CHOICES.filter((k) => kinds.includes(k.key)).map((k) => k.label.toLowerCase());
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Guests with a mobile number on their booking are sent: ${list}. At most ${cap.toLocaleString("en-GB")} a month.`;
}

export type SmsUsage = {
  plan_enabled: boolean;
  cap: number;
  used_this_month: number;
  months: { month: string; sent: number; waiting: number; failed: number }[];
};
export type SmsFailure = { id: string; kind: string; to: string; error: string | null; attempts: number; created_at: string };

/** Reads what sms_usage returned; anything that is not the expected shape reads as empty. */
export function parseUsage(raw: unknown): SmsUsage {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const months = Array.isArray(o.months)
    ? o.months.flatMap((m) => {
        if (typeof m !== "object" || m === null) return [];
        const r = m as Record<string, unknown>;
        return typeof r.month === "string" ? [{ month: r.month, sent: n(r.sent), waiting: n(r.waiting), failed: n(r.failed) }] : [];
      })
    : [];
  return { plan_enabled: o.plan_enabled !== false, cap: n(o.cap), used_this_month: n(o.used_this_month), months };
}

export function parseFailures(raw: unknown): SmsFailure[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    if (typeof f !== "object" || f === null) return [];
    const r = f as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.kind !== "string" || typeof r.to !== "string" || typeof r.created_at !== "string") return [];
    return [
      {
        id: r.id,
        kind: r.kind,
        to: r.to,
        error: typeof r.error === "string" ? r.error : null,
        attempts: typeof r.attempts === "number" ? r.attempts : 0,
        created_at: r.created_at,
      },
    ];
  });
}

export function kindLabel(kind: string): string {
  return SMS_KIND_CHOICES.find((k) => k.key === kind)?.label ?? kind;
}
