import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/env";
import { safeNext } from "@/lib/staff/auth";

/**
 * Keeps the staff session alive and is the first gate for /app.
 *
 * Supabase access tokens are short-lived. Server components cannot write cookies, so something earlier in
 * the request has to refresh them: this does, once per request, before any page runs. It also sends
 * signed-out visitors to /login (remembering where they were going) and signed-in ones away from it.
 * It is only the first layer: every page and API route checks the session again, and the database
 * enforces permissions on every query.
 */
export async function proxy(request: NextRequest) {
  const env = publicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser asks the auth server to verify the token (getSession would only read the cookie).
  const { data } = await supabase.auth.getUser();
  const { pathname, search } = request.nextUrl;

  if (!data.user && pathname.startsWith("/app")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  if (data.user && pathname === "/login") {
    const url = request.nextUrl.clone();
    const target = new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url);
    url.pathname = target.pathname;
    url.search = target.search;
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = { matcher: ["/app/:path*", "/login", "/api/staff/:path*"] };
