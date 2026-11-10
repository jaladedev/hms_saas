/** Custom roles (migration 084): the permission list an owner can pick from, and the same rules the database enforces, so the form can say no first. */

export const OWNER_ONLY_PERMISSION = "staff.manage";

/** Every permission a custom role may hold, grouped and worded for a hotel owner. staff.manage is not here on purpose. */
export const PERMISSION_GROUPS: { title: string; items: { key: string; label: string }[] }[] = [
  { title: "Rooms", items: [
    { key: "room.view", label: "See rooms and their status" }, { key: "room.assign", label: "Assign and move guests between rooms" }, { key: "room.block", label: "Block rooms" }] },
  { title: "Bookings", items: [
    { key: "reservation.view", label: "See bookings" }, { key: "reservation.create", label: "Create bookings" }, { key: "reservation.modify", label: "Change bookings and answer guest requests" },
    { key: "reservation.cancel", label: "Cancel bookings" }, { key: "reservation.checkin", label: "Check guests in" }, { key: "reservation.checkout", label: "Check guests out" }] },
  { title: "Guests", items: [{ key: "guest.view", label: "See guest details" }, { key: "guest.manage", label: "Edit guest details" }] },
  { title: "Money", items: [
    { key: "payment.record", label: "Record payments" }, { key: "payment.verify", label: "Verify payments" }, { key: "refund.request", label: "Request refunds" },
    { key: "refund.approve", label: "Approve refunds" }, { key: "invoice.issue", label: "Issue invoices" }, { key: "invoice.void", label: "Void invoices" }, { key: "folio.charge", label: "Add charges to a guest's bill" },
    { key: "discount.apply", label: "Give discounts" }, { key: "rate.view", label: "See rates" }, { key: "rate.manage", label: "Change rates" }] },
  { title: "Reports and records", items: [
    { key: "report.view", label: "See reports" }, { key: "report.export", label: "Export reports" }, { key: "audit.view", label: "See the audit trail" }] },
  { title: "Housekeeping and repairs", items: [
    { key: "housekeeping.view", label: "See cleaning tasks" }, { key: "housekeeping.update", label: "Update cleaning status" }, { key: "housekeeping.assign", label: "Assign cleaning tasks" }, { key: "maintenance.view", label: "See repair requests" }, { key: "maintenance.manage", label: "Manage repairs" }] },
  { title: "Hotel settings", items: [{ key: "property.configure", label: "Change hotel settings, policies and taxes" }] },
];

export const ALL_PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export type RoleInput = { name: string; permissions: string[] };
export type RoleCheck = { ok: true; value: RoleInput } | { ok: false; code: "role_name" | "role_permissions" };

/** The form's checks. The database repeats all of them and also checks the name against the group's other roles. */
export function validateRole(name: unknown, permissions: unknown): RoleCheck {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 2 || n.length > 60 || /[<>]/.test(n)) return { ok: false, code: "role_name" };
  const list = Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === "string") : [];
  const unique = [...new Set(list)];
  if (unique.length === 0 || unique.some((p) => !ALL_PERMISSION_KEYS.includes(p))) return { ok: false, code: "role_permissions" };
  if (unique.includes("refund.request") && unique.includes("refund.approve")) return { ok: false, code: "role_permissions" };
  return { ok: true, value: { name: n, permissions: unique } };
}

/** Keys of custom roles, as the database writes them: custom.<slug>.<8 hex of the group id>. */
export const CUSTOM_ROLE_KEY = /^custom\.[a-z0-9-]{1,40}\.[0-9a-f]{8}$/;
export const SYSTEM_ROLE_KEY = /^[a-z0-9_]{2,40}$/;
export const isRoleKey = (v: unknown): v is string => typeof v === "string" && (SYSTEM_ROLE_KEY.test(v) || CUSTOM_ROLE_KEY.test(v));

export type CustomRole = { id: string; key: string; name: string; permissions: string[]; holders: number };

export function parseCustomRoles(data: unknown): CustomRole[] {
  return Array.isArray(data) ? (data as CustomRole[]).filter((r) => r && typeof r.id === "string" && Array.isArray(r.permissions)) : [];
}

export const permissionLabel = (key: string) => PERMISSION_GROUPS.flatMap((g) => g.items).find((i) => i.key === key)?.label ?? key;

/** One line for a role in a list: "Night auditor: 3 permissions, held by 2 people". */
export function roleSummary(r: Pick<CustomRole, "permissions" | "holders">): string {
  const p = r.permissions.length;
  return `${p} permission${p === 1 ? "" : "s"}, ${r.holders === 0 ? "nobody holds it yet" : `held by ${r.holders} ${r.holders === 1 ? "person" : "people"}`}`;
}
