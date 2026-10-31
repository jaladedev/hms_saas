"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { classifyAuthError, safeNext } from "./auth";

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
