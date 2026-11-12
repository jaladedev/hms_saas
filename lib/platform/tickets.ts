/**
 * Support tickets kept by the platform team (migration 110). Pure rules and readers, tested without a server. They mirror the
 * database checks so a mistake is explained on the form, but the database decides. A ticket never holds a reservation, guest,
 * payment or secret.
 */

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["normal", "high"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};
export const PRIORITY_LABEL: Record<TicketPriority, string> = { normal: "Normal", high: "High" };

export const isTicketStatus = (v: unknown): v is TicketStatus => TICKET_STATUSES.includes(v as TicketStatus);
export const isTicketPriority = (v: unknown): v is TicketPriority => TICKET_PRIORITIES.includes(v as TicketPriority);

export const MAX_TITLE = 120;
export const MAX_DETAILS = 2000;
export const MAX_NOTE = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export type NewTicket = { tenantId: string; title: string; details: string; priority: TicketPriority };

/** Reads the "open a ticket" form. Null means refused: a bad hotel, a title outside 3 to 120, details over 2,000 or an unknown priority. */
export function parseNewTicket(raw: Record<string, unknown>): NewTicket | null {
  const tenantId = text(raw.tenantId);
  const title = text(raw.title).replace(/\s+/g, " ");
  const details = text(raw.details);
  const priority = text(raw.priority) || "normal";
  if (!UUID.test(tenantId) || title.length < 3 || title.length > MAX_TITLE || details.length > MAX_DETAILS || !isTicketPriority(priority))
    return null;
  return { tenantId, title, details, priority };
}

/** A note of 1 to 1,000 characters, trimmed; null when blank or too long. */
export function parseNote(v: unknown): string | null {
  const n = text(v);
  return n.length >= 1 && n.length <= MAX_NOTE ? n : null;
}

export type TicketRow = {
  id: string;
  number: string;
  tenant_id: string;
  tenant_name: string;
  title: string;
  priority: TicketPriority;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  notes: number;
};

export type TicketNote = { id: string; note: string; created_at: string; author: string | null };
export type TicketDetail = Omit<TicketRow, "notes"> & { details: string | null; resolved_at: string | null; notes: TicketNote[] };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function base(r: Record<string, unknown>) {
  return {
    id: str(r.id),
    number: str(r.number),
    tenant_id: str(r.tenant_id),
    tenant_name: str(r.tenant_name),
    title: str(r.title),
    priority: isTicketPriority(r.priority) ? r.priority : ("normal" as const),
    status: isTicketStatus(r.status) ? r.status : ("open" as const),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

/** The list answer, read defensively: anything that is not the expected shape is dropped. */
export function readTickets(raw: unknown): TicketRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(rec)
    .filter((r) => typeof r.id === "string" && r.id !== "")
    .map((r) => ({ ...base(r), notes: typeof r.notes === "number" && r.notes >= 0 ? r.notes : 0 }));
}

/** One ticket with its notes, or null when the answer is not a ticket. */
export function readTicketDetail(raw: unknown): TicketDetail | null {
  const r = rec(raw);
  if (typeof r.id !== "string" || r.id === "") return null;
  const notes = (Array.isArray(r.notes) ? r.notes : []).map(rec).map((n) => ({
    id: str(n.id),
    note: str(n.note),
    created_at: str(n.created_at),
    author: typeof n.author === "string" ? n.author : null,
  }));
  return {
    ...base(r),
    details: typeof r.details === "string" ? r.details : null,
    resolved_at: typeof r.resolved_at === "string" ? r.resolved_at : null,
    notes,
  };
}

/** How many tickets still need work (open or in progress). */
export function openCount(rows: Pick<TicketRow, "status">[]): number {
  return rows.filter((r) => r.status === "open" || r.status === "in_progress").length;
}
