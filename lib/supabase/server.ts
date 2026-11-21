import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { publicEnv } from "@/lib/env";
import { clientIp } from "@/lib/rate-limit";
import type { Database } from "@/lib/supabase/database";
import { SESSION_ONLY_COOKIE, sessionCookieOptions } from "@/lib/supabase/session-policy";

/**
 * Server client acting as the signed-in user. All reads go through RLS.
 * `sessionOnly` is given only by the sign-in, which knows the answer before the flag cookie exists; everything else follows the flag.
 */
export async function createClient(opts: { sessionOnly?: boolean } = {}) {
  const env = publicEnv();
  const cookieStore = await cookies();
  // The address the person's request came from, passed on so the audit log can record it (migration 170). Nothing when unknown.
  const ip = clientIp(await headers());
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: ip === "unknown" ? {} : { "x-client-ip": ip } },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          const sessionOnly = opts.sessionOnly ?? cookieStore.get(SESSION_ONLY_COOKIE) !== undefined;
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, sessionCookieOptions(options, sessionOnly)));
        } catch {
          // Called from a Server Component: session refresh is handled elsewhere.
        }
      },
    },
  });
}
