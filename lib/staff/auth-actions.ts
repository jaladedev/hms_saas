"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { classifyAuthError, classifyUpdateError, safeNext, siteOrigin, validateNewPassword } from "./auth";

function toLogin(code: string, next: string | undefined): never {
  const qs = new URLSearchParams({ err: code });
  const target = safeNext(next);
  if (target !== "/app") qs.set("next", target);
  redirect(`/login?${qs.toString()}`);
}

/**
 * Signs a staff member in with email and password. The session lives in Supabase's cookies (set through
 * the server client), so every later request, page or API, runs as that person under row level security.
 * A correct password is not enough: the account must also be an active member of at least one hotel.
 */
export async function signIn(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const next = typeof raw.next === "string" ? raw.next : undefined;
  const parsed = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) }).safeParse({
    email: typeof raw.email === "string" ? raw.email.trim() : "", password: raw.password,
  });
  if (!parsed.success) return toLogin("invalid", next);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return toLogin(classifyAuthError(error), next);

  const { data: memberships, error: memberError } = await supabase
    .from("tenant_memberships").select("id").eq("status", "active").limit(1);
  if (memberError) {
    await supabase.auth.signOut();
    return toLogin("unavailable", next);
  }
  if (!memberships || memberships.length === 0) {
    await supabase.auth.signOut();
    return toLogin("no_access", next);
  }
  redirect(safeNext(next));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Emails a password recovery link. The answer is the same whether or not the address belongs to an
 * account, so this page cannot be used to find out who has one. Only a rate limit or an outage is
 * reported, and neither says anything about the address.
 */
export async function requestPasswordReset(formData: FormData) {
  const parsed = z.object({ email: z.email().max(254) }).safeParse({
    email: typeof formData.get("email") === "string" ? String(formData.get("email")).trim() : "",
  });
  if (!parsed.success) redirect("/forgot-password?sent=1");   // a malformed address gets the same screen

  const origin = siteOrigin(await headers(), process.env.NODE_ENV === "production");
  if (!origin) redirect("/forgot-password?err=unavailable");

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });
  if (error?.status === 429) redirect("/forgot-password?err=rate");
  if (error && (error.status === undefined || error.status >= 500)) redirect("/forgot-password?err=unavailable");
  redirect("/forgot-password?sent=1");
}

/**
 * Sets a new password for the person the recovery link signed in. Afterwards every session of the account
 * is ended (a reset usually means someone else may have had the old password), and they sign in again.
 */
export async function updatePassword(formData: FormData) {
  const password = typeof formData.get("password") === "string" ? String(formData.get("password")) : "";
  const confirm = typeof formData.get("confirm") === "string" ? String(formData.get("confirm")) : "";
  const problem = validateNewPassword(password, confirm);
  if (problem) redirect(`/reset-password?err=${problem}`);

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/reset-password?err=expired");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) redirect(`/reset-password?err=${classifyUpdateError(error)}`);

  await supabase.auth.signOut({ scope: "global" });
  redirect("/login?ok=reset");
}
