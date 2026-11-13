export type WaitlistStatus = "waiting" | "contacted";
export type WaitlistRow = {
  id: string;
  room_type: string;
  arrival_date: string;
  departure_date: string;
  adults: number;
  children: number;
  guest_name: string;
  email: string;
  phone: string | null;
  status: WaitlistStatus;
  created_at: string;
  rooms_free_now: number;
};

/** Reads what waitlist_list returned; anything that is not a well formed row is dropped rather than shown wrong. */
export function parseWaitlist(data: unknown): WaitlistRow[] {
  if (!Array.isArray(data)) return [];
  const rows: WaitlistRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : 0);
    if (!s("id") || !s("guest_name") || !s("arrival_date") || !s("departure_date")) continue;
    rows.push({
      id: s("id"),
      room_type: s("room_type"),
      arrival_date: s("arrival_date"),
      departure_date: s("departure_date"),
      adults: n("adults"),
      children: n("children"),
      guest_name: s("guest_name"),
      email: s("email"),
      phone: s("phone") || null,
      status: o.status === "contacted" ? "contacted" : "waiting",
      created_at: s("created_at"),
      rooms_free_now: Math.max(0, Math.trunc(n("rooms_free_now"))),
    });
  }
  return rows;
}

/** "2 free now", "Sold out"; a room that has freed up is what staff act on. */
export function freeLabel(row: Pick<WaitlistRow, "rooms_free_now">): string {
  return row.rooms_free_now > 0 ? `${row.rooms_free_now} free now` : "Still sold out";
}

/** Rooms that have freed up come first (those are the calls to make), then the soonest arrival. */
export function sortWaitlist(rows: WaitlistRow[]): WaitlistRow[] {
  return [...rows].sort((a, b) => {
    const fa = a.rooms_free_now > 0 ? 0 : 1;
    const fb = b.rooms_free_now > 0 ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (a.arrival_date !== b.arrival_date) return a.arrival_date < b.arrival_date ? -1 : 1;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

/** Whether any request is a room that is free now; used for the heading note. */
export function freeCount(rows: WaitlistRow[]): number {
  return rows.filter((r) => r.rooms_free_now > 0 && r.status === "waiting").length;
}
