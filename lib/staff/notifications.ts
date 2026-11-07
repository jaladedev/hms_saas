export type NotificationCategory = "money" | "maintenance" | "booking" | "housekeeping";
export type NotificationSeverity = "info" | "attention" | "urgent";

export type NotificationItem = {
  id: string;
  property_id: string;
  property_name: string;
  kind: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
};
export type NotificationUnread = { total: number } & Record<NotificationCategory, number>;
export type Inbox = { items: NotificationItem[]; unread: NotificationUnread };

export const CATEGORIES: NotificationCategory[] = ["money", "maintenance", "booking", "housekeeping"];
export const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  money: "Money", maintenance: "Maintenance", booking: "Bookings", housekeeping: "Housekeeping",
};
export const SEVERITY_LABEL: Record<NotificationSeverity, string> = { info: "For your information", attention: "Needs attention", urgent: "Urgent" };

export const EMPTY_UNREAD: NotificationUnread = { total: 0, money: 0, maintenance: 0, booking: 0, housekeeping: 0 };

export function parseCategory(v: string | string[] | undefined): NotificationCategory | null {
  const s = Array.isArray(v) ? v[0] : v;
  return CATEGORIES.find((c) => c === s) ?? null;
}

/** The inbox as the database returns it, with anything malformed dropped rather than shown wrongly. */
export function parseInbox(data: unknown): Inbox {
  const d = (data ?? {}) as { items?: unknown; unread?: Partial<NotificationUnread> };
  const items = Array.isArray(d.items)
    ? (d.items as NotificationItem[]).filter((i) => i && typeof i.id === "string" && CATEGORIES.includes(i.category) && typeof i.title === "string")
    : [];
  const u = d.unread ?? {};
  const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
  return { items, unread: { total: n(u.total), money: n(u.money), maintenance: n(u.maintenance), booking: n(u.booking), housekeeping: n(u.housekeeping) } };
}

/** A link is followed only when it is a path inside the staff app. */
export function safeLink(link: string | null): string | null {
  return link && /^\/app(\/[A-Za-z0-9_-]+)*$/.test(link) ? link : null;
}

/** "99+" keeps the nav badge narrow. */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Urgent first within a day is not wanted: the list stays newest first, so only the chip carries severity. */
export function severityRank(s: NotificationSeverity): number {
  return s === "urgent" ? 0 : s === "attention" ? 1 : 2;
}

/** Items grouped by the day they arrived in the hotel's own time zone, keeping their order. */
export function groupByDay(items: NotificationItem[], timeZone: string): { day: string; items: NotificationItem[] }[] {
  const fmt = (iso: string) => {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return "Unknown date";
    try {
      return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone }).format(t);
    } catch {
      return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(t);
    }
  };
  const groups: { day: string; items: NotificationItem[] }[] = [];
  for (const i of items) {
    const day = fmt(i.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(i);
    else groups.push({ day, items: [i] });
  }
  return groups;
}
