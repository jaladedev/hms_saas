"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { staffClient } from "./action-helpers";
import { ACTIVE_PROPERTY_COOKIE, isPropertyId, returnPath, withoutPropertyParam } from "./property-choice";

/**
 * Remembers which property the person works in. Only a choice among properties they can already read is stored (the read
 * runs under their own login), and the cookie is a preference, not a permission: every page and every database call still
 * checks access on its own.
 */
export async function setActiveProperty(formData: FormData) {
  const supabase = await staffClient();
  const back = returnPath(String(formData.get("returnTo") ?? ""));
  const id = formData.get("propertyId");
  if (isPropertyId(id)) {
    const { data } = await supabase.from("properties").select("id").eq("id", id).maybeSingle();
    if (data) {
      (await cookies()).set(ACTIVE_PROPERTY_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/app", maxAge: 60 * 60 * 24 * 365 });
    }
  }
  redirect(withoutPropertyParam(back));
}
