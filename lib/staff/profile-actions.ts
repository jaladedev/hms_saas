"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyUpdateError, validateNewPassword } from "./auth";
import { checkProfileForm, profileErrorCode } from "./profile";

const PAGE = "/app/profile";

/** Saves the signed-in person's own name, phone and display setting through update_my_profile. It can only touch their own row. */
export async function saveProfile(formData: FormData) {
  const parsed = z
    .object({ full_name: z.string().max(400), phone: z.string().max(400), density: z.string().max(40) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const problem = checkProfileForm(parsed.data);
  if (problem) return back(PAGE, { err: problem });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_my_profile", {
    p_full_name: parsed.data.full_name,
    p_phone: parsed.data.phone,
    p_density: parsed.data.density,
  });
  if (error) return back(PAGE, { err: profileErrorCode(error.message) ?? "bad_request" });
  // The density is read by the layout, so every staff page picks it up, not just this one.
  revalidatePath("/app", "layout");
  return ok(PAGE, "profile_saved");
}

/**
 * Changes the signed-in person's password. The current password is checked first, so a session left open on a shared
 * desk cannot be used to take over the account. Afterwards every other sign-in of the account is ended, and this one stays.
 */
export async function changePassword(formData: FormData) {
  const str = (k: string) => (typeof formData.get(k) === "string" ? String(formData.get(k)) : "");
  const current = str("current");
  const password = str("password");
  const confirm = str("confirm");
  const problem = validateNewPassword(password, confirm);
  if (problem) return back(PAGE, { err: `pw_${problem}` });
  if (current.length === 0 || current.length > 200) return back(PAGE, { err: "wrong_password" });

  const supabase = await staffClient();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email;
  if (!email) return redirect("/login");

  const check = await supabase.auth.signInWithPassword({ email, password: current });
  if (check.error) return back(PAGE, { err: check.error.status === 400 ? "wrong_password" : "pw_failed" });

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const kind = classifyUpdateError(error);
    return back(PAGE, { err: kind === "expired" ? "pw_failed" : `pw_${kind}` });
  }
  await supabase.auth.signOut({ scope: "others" });
  return ok(PAGE, "password_changed");
}
