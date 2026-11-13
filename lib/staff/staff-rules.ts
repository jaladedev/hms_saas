/** Display and control rules for the staff screen. Pure; the database enforces who may do what. */

export type MemberRole = { id: string; role_key: string; role_name: string; property_id: string | null };
export type Member = {
  membership_id: string;
  tenant_id: string;
  user_id: string;
  status: string;
  email: string | null;
  full_name: string | null;
  is_self: boolean;
  /** When the person last signed in (Supabase auth), or null if never. A refreshed session does not change it. */
  last_sign_in_at?: string | null;
  roles: MemberRole[];
};

/** What a role is for, in the owner's words. Unknown (custom) roles just show their name. */
export const ROLE_HELP: Record<string, string> = {
  owner: "Everything, including managing staff and money",
  general_manager: "Everything except managing staff",
  front_desk: "Bookings, check-in and check-out, payments, invoices, room status",
  reservations_officer: "Create, change and cancel bookings; assign rooms; see rates",
  accountant: "Payments, invoices, refunds (request and approve), reports",
  housekeeping: "See rooms and update cleaning status",
  maintenance: "See rooms and manage maintenance",
};

export const scopeLabel = (propertyId: string | null, names: Map<string, string>) =>
  propertyId === null ? "all properties" : (names.get(propertyId) ?? "one property");

export type MemberActions = { suspend: boolean; reinstate: boolean; revoke: boolean; addRole: boolean; removeRole: boolean };

/**
 * Which controls to show for a person. Nobody changes their own access (the database refuses it too), a
 * revoked person is only brought back through the invite form, and a suspended one is reinstated before
 * their roles change. Whether the viewer may touch a particular role is decided in the database.
 */
export function memberActions(m: Pick<Member, "status" | "is_self">): MemberActions {
  const none: MemberActions = { suspend: false, reinstate: false, revoke: false, addRole: false, removeRole: false };
  if (m.is_self || m.status === "revoked") return none;
  if (m.status === "suspended") return { ...none, reinstate: true, revoke: true };
  return { suspend: true, reinstate: false, revoke: true, addRole: true, removeRole: true };
}

/** Name to show for a person: their name when known, else their email. */
export const memberLabel = (m: Pick<Member, "full_name" | "email">) => m.full_name?.trim() || m.email || "Unknown person";

/**
 * "Last sign-in" text for the staff list: "Not signed in yet", "Signed in just now", "Signed in 5 hours ago", "1 day ago",
 * "12 days ago", or the date after 30 days. It is the time of the last sign-in, not of the last click, so it is worded that way.
 * `fmt` turns an ISO date (yyyy-mm-dd) into the page's date style.
 */
export function lastSignInText(iso: string | null | undefined, now: Date, fmt: (isoDate: string) => string): string {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return "Not signed in yet";
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (minutes < 5) return "Signed in just now";
  if (minutes < 60) return `Signed in ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Signed in ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Signed in ${days} ${days === 1 ? "day" : "days"} ago`;
  return `Last signed in ${fmt(t.toISOString().slice(0, 10))}`;
}
