import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

/**
 * Service-role client. It bypasses RLS and is the only way to call the service_role-only
 * functions (create_hold, create_payment_attempt, confirm_payment, guest_booking_status, ...).
 * Use it only in route handlers and server actions, never in client components, and never
 * pass it a tenant or property id that came from the browser.
 */
export function createServiceClient() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
