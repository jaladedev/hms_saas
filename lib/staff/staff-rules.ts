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
