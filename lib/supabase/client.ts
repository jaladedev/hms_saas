import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

/** Browser client: publishable key and the signed-in user's session only. */
export function createClient() {
  const env = publicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
