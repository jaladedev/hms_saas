"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import { back, fail, ok, staffClient } from "./action-helpers";
import { siteOrigin } from "./auth";
import { isRoleKey } from "./custom-roles";

/**
 * Staff management actions. Each runs as the signed-in person, so the database decides who may do what
 * (staff.manage, role escalation, self change, last owner). The one step that cannot run as them is creating a login
 * for someone new: that uses the service key, and only after the database has already said this person may
 * make exactly this grant, so a refused request never sends an email.
 */

const PAGE = "/app/staff";
const uuid = z.guid();
const roleKey = z.string().refine(isRoleKey);
const property = z.union([uuid, z.literal("")]);

export async function inviteStaff(formData: FormData) {
  const parsed = z.object({ tenantId: uuid, email: z.string().max(254), roleKey, propertyId: property }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const email = parsed.data.email.trim().toLowerCase();
  if (!z.email().safeParse(email).success) return back(PAGE, { err: "email_invalid" });
  const propertyId = parsed.data.propertyId || null;

  const supabase = await staffClient();
  const check = await supabase.rpc("staff_check_grant", { p_tenant: parsed.data.tenantId, p_role_key: parsed.data.roleKey, p_property: propertyId });
  if (check.error) return fail(PAGE, check.error.message);

  const service = createServiceClient();
  const found = await service.rpc("find_user_id_by_email", { p_email: email });
  if (found.error) return back(PAGE, { err: "invite_failed" });
  let userId = (found.data as string | null) ?? null;
  if (!userId) {
    const origin = siteOrigin(await headers(), process.env.NODE_ENV === "production");
    if (!origin) return back(PAGE, { err: "invite_failed" });
    const invited = await service.auth.admin.inviteUserByEmail(email, { redirectTo: `${origin}/auth/callback?next=/reset-password` });
    if (invited.error || !invited.data.user) return back(PAGE, { err: "invite_failed" });
    userId = invited.data.user.id;
  }

  const added = await supabase.rpc("add_staff_member", {
    p_tenant: parsed.data.tenantId, p_user: userId, p_role_key: parsed.data.roleKey, p_property: propertyId,
  });
  if (added.error) return fail(PAGE, added.error.message);
  revalidatePath(PAGE);
  return ok(PAGE, "staff_added");
}

export async function addStaffRole(formData: FormData) {
  const parsed = z.object({ tenantId: uuid, userId: uuid, roleKey, propertyId: property }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("add_staff_member", {
    p_tenant: parsed.data.tenantId, p_user: parsed.data.userId, p_role_key: parsed.data.roleKey, p_property: parsed.data.propertyId || null,
  });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  return ok(PAGE, "staff_added");
}

export async function removeStaffRole(formData: FormData) {
  const parsed = z.object({ membershipRoleId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("remove_staff_role", { p_membership_role: parsed.data.membershipRoleId });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  return ok(PAGE, "staff_role_removed");
}

export async function setStaffStatus(formData: FormData) {
  const parsed = z.object({ membershipId: uuid, status: z.enum(["active", "suspended", "revoked"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_staff_status", { p_membership: parsed.data.membershipId, p_status: parsed.data.status });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  return ok(PAGE, parsed.data.status === "active" ? "staff_reinstated" : parsed.data.status === "suspended" ? "staff_suspended_ok" : "staff_revoked_ok");
}
