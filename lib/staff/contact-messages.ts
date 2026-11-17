export type ContactMessage = {
  id: string;
  guest_name: string;
  email: string;
  message: string;
  status: "new" | "handled";
  created_at: string;
  handled_at: string | null;
};

/** Reads what contact_messages_list returned; anything that is not a well formed row is dropped rather than shown wrong. */
export function parseContactMessages(data: unknown): ContactMessage[] {
  if (!Array.isArray(data)) return [];
  const rows: ContactMessage[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    if (!s("id") || !s("guest_name") || !s("message")) continue;
    rows.push({
      id: s("id"),
      guest_name: s("guest_name"),
      email: s("email"),
      message: s("message"),
      status: o.status === "handled" ? "handled" : "new",
      created_at: s("created_at"),
      handled_at: s("handled_at") || null,
    });
  }
  return rows;
}

/** New messages first, oldest first (the longest wait is answered first); handled ones after, newest first. */
export function sortMessages(rows: ContactMessage[]): ContactMessage[] {
  const t = (iso: string) => (iso ? Date.parse(iso) || 0 : 0);
  return [...rows].sort((a, b) => {
    if (a.status !== b.status) return a.status === "new" ? -1 : 1;
    return a.status === "new" ? t(a.created_at) - t(b.created_at) : t(b.handled_at ?? b.created_at) - t(a.handled_at ?? a.created_at);
  });
}

export function newCount(rows: ContactMessage[]): number {
  return rows.filter((r) => r.status === "new").length;
}
