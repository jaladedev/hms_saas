import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { publicEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database";
import { SESSION_ONLY_COOKIE, sessionCookieOptions } from "@/lib/supabase/session-policy";

/**
 * Server client acting as the signed-in user. All reads go through RLS.
 * `sessionOnly` is given only by the sign-in, which knows the answer before the flag cookie exists; everything else follows the flag.
 */
export async function createClient(opts: { sessionOnly?: boolean } = {}) {
  const env = publicEnv();
  const cookieStore = await cookies();
  return createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
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
