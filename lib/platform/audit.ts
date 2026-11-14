/**
 * The platform's audit trail (migration 126): who on the platform team did what, to which hotel group. Pure rules and readers,
 * tested without a server. The database decides what is a platform event and what is returned; a row holds no ticket, note or
 * reason text, only which fields a change touched.
 */

export const AUDIT_PAGE_SIZE = 50;

export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  actor: string | null;
  fields: string[];
};
export type AuditPage = { events: AuditEvent[]; has_more: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export type AuditFilter = { hotel: string; search: string; from: string; to: string; beforeAt: string; beforeId: string };

/** Reads the page's query string. Anything that is not a plain id, a calendar date or short text is dropped, never passed on. */
export function parseAuditFilter(raw: Record<string, unknown>): AuditFilter {
  const date = (v: unknown): string => {
    const s = text(v);
    if (!DATE.test(s)) return "";
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? "" : s;
  };
  const at = text(raw.beforeAt);
  const atOk = !Number.isNaN(new Date(at).getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(at);
  const id = text(raw.beforeId);
  const search = text(raw.q).replace(/\s+/g, " ").slice(0, 60);
  const hotel = text(raw.hotel);
  return {
    hotel: UUID.test(hotel) ? hotel : "",
    search,
    from: date(raw.from),
    to: date(raw.to),
    beforeAt: atOk && UUID.test(id) ? at : "",
    beforeId: atOk && UUID.test(id) ? id : "",
  };
}

const KNOWN: Record<string, string> = {
  "platform.tenant_created": "Hotel group created",
  "platform.tenant_status_changed": "Hotel group status changed",
  "platform.domain_added": "Web address added",
  "platform.domain_verified": "Web address verified",
  "platform.domain_unverified": "Web address unverified",
  "platform.payment_account_status_changed": "Payment account status changed",
  "platform.owner_invite_resent": "Owner invitation resent",
};
const ENTITY: Record<string, string> = {
  platform_invoice: "invoice",
  platform_ticket: "support ticket",
  platform_ticket_note: "ticket note",
  platform_access: "access request",
};
const VERB: Record<string, string> = { created: "created", updated: "updated", deleted: "deleted" };

/** A sentence for an action key. Unknown keys are shown as written so nothing is hidden. */
export function describeAction(action: string): string {
  if (KNOWN[action]) return KNOWN[action];
  const dot = action.indexOf(".");
  if (dot > 0) {
    const entity = action.slice(0, dot);
    const verb = action.slice(dot + 1);
    const noun = ENTITY[entity];
    if (noun && VERB[verb]) return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${VERB[verb]}`;
  }
  return action;
}

/** "status, priority" for a change's touched fields; empty when it is not a change. Underscores read as spaces. */
export function describeFields(fields: readonly string[]): string {
  return fields.map((f) => f.replace(/_/g, " ")).join(", ");
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Reads the database's answer. Rows that are not an object with an id and a time are skipped. */
export function readAuditPage(data: unknown): AuditPage {
  const d = (data ?? {}) as { events?: unknown; has_more?: unknown };
  const events: AuditEvent[] = [];
  for (const r of Array.isArray(d.events) ? d.events : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.at !== "string") continue;
    events.push({
      id: o.id,
      at: o.at,
      action: str(o.action) ?? "unknown",
      entity_type: str(o.entity_type) ?? "",
      entity_id: str(o.entity_id),
      tenant_id: str(o.tenant_id),
      tenant_name: str(o.tenant_name),
      actor: str(o.actor),
      fields: Array.isArray(o.fields) ? o.fields.filter((f): f is string => typeof f === "string") : [],
    });
  }
  return { events, has_more: d.has_more === true };
}

/** The filters as a query string, without the page cursor (the link back to the newest page). */
export function filterQuery(filter: AuditFilter): string {
  const p = new URLSearchParams();
  if (filter.hotel) p.set("hotel", filter.hotel);
  if (filter.search) p.set("q", filter.search);
  if (filter.from) p.set("from", filter.from);
  if (filter.to) p.set("to", filter.to);
  return p.toString();
}

/** Query string for the next page: the same filters plus the last event's time and id. */
export function nextPageQuery(filter: AuditFilter, last: Pick<AuditEvent, "at" | "id">): string {
  const p = new URLSearchParams(filterQuery(filter));
  p.set("beforeAt", last.at);
  p.set("beforeId", last.id);
  return p.toString();
}

/** "2026-11-14 16:48" in UTC, the same for everyone on the team. */
export function auditTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
