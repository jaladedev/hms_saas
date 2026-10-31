import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { classifyRpcError, type OkCode } from "./refunds";

/** Shared by the staff server actions: redirect back to a page with a short result code in the URL. */
export function back(path: string, params: Record<string, string | number>): never {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  redirect(`${path}?${qs.toString()}`);
}
export const ok = (path: string, code: OkCode): never => back(path, { ok: code });

/** Turns a database refusal into an ?err= code; the page words it, raw database text never reaches the browser. */
export function fail(path: string, message: string): never {
  const c = classifyRpcError(message);
  return back(path, c.refundableMinor !== undefined ? { err: c.code, n: c.refundableMinor } : { err: c.code });
}

/** The signed-in staff member's client (every call runs under their own permissions), or a redirect to sign in. */
export async function staffClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return supabase;
}
