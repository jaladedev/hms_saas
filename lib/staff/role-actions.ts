"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { validateRole } from "./custom-roles";

/** "POLICY_VIOLATION: name" is also the guest form's message, so it is read here, not in the shared classifier. */
function failRole(message: string): never {
  return /POLICY_VIOLATION: name(?! taken)/.test(message) ? back(PAGE, { err: "role_name" }) : fail(PAGE, message);
}

/** Custom roles (migration 083). Each action runs as the signed-in person; the database allows only someone who manages the hotel group. */
const PAGE = "/app/staff/roles";
const uuid = z.guid();

function readForm(formData: FormData) {
  return validateRole(formData.get("name"), formData.getAll("permission"));
}

export async function createRole(formData: FormData) {
  const tenantId = uuid.safeParse(formData.get("tenantId"));
  if (!tenantId.success) return back(PAGE, { err: "bad_request" });
  const checked = readForm(formData);
  if (!checked.ok) return back(PAGE, { err: checked.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("create_custom_role", {
    p_tenant: tenantId.data,
    p_name: checked.value.name,
    p_permissions: checked.value.permissions,
  });
  if (error) return failRole(error.message);
  revalidatePath(PAGE);
  revalidatePath("/app/staff");
  return ok(PAGE, "role_created");
}

export async function updateRole(formData: FormData) {
  const roleId = uuid.safeParse(formData.get("roleId"));
  if (!roleId.success) return back(PAGE, { err: "bad_request" });
  const checked = readForm(formData);
  if (!checked.ok) return back(PAGE, { err: checked.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_custom_role", {
    p_role: roleId.data,
    p_name: checked.value.name,
    p_permissions: checked.value.permissions,
  });
  if (error) return failRole(error.message);
  revalidatePath(PAGE);
  revalidatePath("/app/staff");
  return ok(PAGE, "role_updated");
}

export async function deleteRole(formData: FormData) {
  const roleId = uuid.safeParse(formData.get("roleId"));
  if (!roleId.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_custom_role", { p_role: roleId.data });
  if (error) return failRole(error.message);
  revalidatePath(PAGE);
  revalidatePath("/app/staff");
  return ok(PAGE, "role_deleted");
}
