import { NextResponse, type NextRequest } from "next/server";
import { callbackTarget } from "@/lib/staff/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the link in a recovery email lands. It turns the one-time code into a session cookie, then sends the
 * person to the reset page (or an /app path); a bad, used or expired link goes to the reset page's
 * "expired" state. Two link styles are accepted: the default code (works only in the browser that asked
 * for the email) and a token hash, for hotels that change the email template so the link also works on a phone.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const target = callbackTarget(params.get("next"));
  const supabase = await createClient();

  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && params.get("type") === "recovery") {
    ok = !(await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash })).error;
  }
  return NextResponse.redirect(new URL(ok ? target : "/reset-password?err=expired", request.nextUrl), 303);
}
