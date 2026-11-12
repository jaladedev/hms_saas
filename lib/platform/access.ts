/**
 * Access requests (migration 111): how platform staff get to look at a hotel's setup. There is no login-as. Pure rules and readers,
 * tested without a server; they mirror the database checks so a mistake is explained on the form, but the database decides.
 */

export const ACCESS_HOURS = [1, 4, 24] as const;
export type AccessHours = (typeof ACCESS_HOURS)[number];
export const MIN_REASON = 10;
export const MAX_REASON = 500;
export const MAX_DECISION_NOTE = 300;

export const ACCESS_STATUSES = ["pending", "approved", "denied", "cancelled", "revoked", "expired"] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];
export const isAccessStatus = (v: unknown): v is AccessStatus => ACCESS_STATUSES.includes(v as AccessStatus);

export const ACCESS_STATUS_LABEL: Record<AccessStatus, string> = {
  pending: "Waiting for an admin",
  approved: "Approved",
  denied: "Denied",
  cancelled: "Withdrawn",
  revoked: "Ended early",
  expired: "Expired",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export type NewAccessRequest = { tenantId: string; reason: string; hours: AccessHours; ticketId: string | null };

/** Reads the request form. Null means refused: a bad hotel, a reason outside 10 to 500 characters, hours other than 1, 4 or 24, or a bad ticket id. */
export function parseAccessRequest(raw: Record<string, unknown>): NewAccessRequest | null {
  const tenantId = text(raw.tenantId);
  const reason = text(raw.reason);
  const hours = Number(text(raw.hours) || "1");
  const ticket = text(raw.ticketId);
  if (!UUID.test(tenantId) || reason.length < MIN_REASON || reason.length > MAX_REASON) return null;
  if (!(ACCESS_HOURS as readonly number[]).includes(hours)) return null;
  if (ticket !== "" && !UUID.test(ticket)) return null;
  return { tenantId, reason, hours: hours as AccessHours, ticketId: ticket === "" ? null : ticket };
}

/** An approve or deny decision with an optional note of up to 300 characters. Null when the decision is neither or the note is too long. */
export function parseAccessDecision(
  raw: Record<string, unknown>,
): { requestId: string; decision: "approved" | "denied"; note: string } | null {
  const requestId = text(raw.requestId);
  const decision = text(raw.decision);
  const note = text(raw.note);
  if (!UUID.test(requestId) || (decision !== "approved" && decision !== "denied") || note.length > MAX_DECISION_NOTE) return null;
  return { requestId, decision, note };
}

export type AccessRow = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  reason: string;
  hours: number;
  ticket_number: string | null;
  status: AccessStatus;
  requested_at: string;
  requested_by_email: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  approved_until: string | null;
  views: number;
  last_viewed_at: string | null;
  mine: boolean;
};

/** The rows of platform_list_access, keeping only well-formed ones. Anything else (an error, null) is an empty list. */
export function readAccess(data: unknown): AccessRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (r): r is AccessRow =>
      !!r &&
      typeof r === "object" &&
      typeof (r as AccessRow).id === "string" &&
      typeof (r as AccessRow).tenant_name === "string" &&
      isAccessStatus((r as AccessRow).status) &&
      typeof (r as AccessRow).requested_at === "string",
  );
}

/** Requests that need an admin's decision, oldest first. */
export function awaitingDecision(rows: AccessRow[]): AccessRow[] {
  return rows.filter((r) => r.status === "pending").sort((a, b) => a.requested_at.localeCompare(b.requested_at));
}

/** How many requests wait for this admin to decide: pending ones that are not their own (an admin may not decide their own request). */
export function waitingForMe(rows: Pick<AccessRow, "status" | "mine">[]): number {
  return rows.filter((r) => r.status === "pending" && !r.mine).length;
}

/** "2 hours 5 minutes left", "Ends in 12 minutes", or null when it is not an approved window (or has run out). */
export function timeLeft(row: Pick<AccessRow, "status" | "approved_until">, now: Date): string | null {
  if (row.status !== "approved" || !row.approved_until) return null;
  const ms = Date.parse(row.approved_until) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.ceil(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} minute${m === 1 ? "" : "s"} left`;
  return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minute${m === 1 ? "" : "s"}` : ""} left`;
}

export type AccessSetup = {
  tenant_name: string;
  tenant_status: string;
  approved_until: string;
  features: { key: string; enabled: boolean }[];
  domains: { host: string; verified: boolean }[];
  payment_accounts: string[];
  roles: { role: string; people: number }[];
  properties: {
    name: string;
    status: string;
    policy_version: number | null;
    room_types: {
      name: string;
      code: string;
      public: boolean;
      status: string;
      max_occupancy: number;
      base_rate_minor: number;
      currency: string;
    }[];
    rate_plans: { name: string; code: string; default: boolean; status: string; cancellation_policy: unknown; payment_policy: unknown }[];
    tax_rules: { name: string; basis: string; rate: number; status: string }[];
  }[];
};

/** The setup view of platform_access_view, or null when it is not shaped as expected. */
export function readSetup(data: unknown): AccessSetup | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<AccessSetup>;
  if (typeof d.tenant_name !== "string" || !Array.isArray(d.properties) || !Array.isArray(d.features) || !Array.isArray(d.domains))
    return null;
  return {
    ...(d as AccessSetup),
    payment_accounts: Array.isArray(d.payment_accounts) ? d.payment_accounts : [],
    roles: Array.isArray(d.roles) ? d.roles : [],
  };
}
