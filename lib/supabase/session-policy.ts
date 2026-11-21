/**
 * "Keep me signed in" on the staff sign-in page.
 *
 * Supabase's session cookies last about a year by default. When a person does not tick "Keep me signed in" (the shared front-desk
 * computer case), the sign-in sets a small flag cookie, and from then on every place that writes the session cookies drops their
 * `maxAge` and `expires`, so the browser forgets the session when it closes. The flag is itself a session cookie, so it goes at the
 * same moment. Ticking the box removes the flag and the cookies keep Supabase's own lifetime.
 *
 * Both writers use this: the server client (`lib/supabase/server.ts`, sign-in, sign-out, password change) and `proxy.ts`, which
 * refreshes the tokens on later requests. If only one did, the first refresh would turn a session-only login back into a
 * year-long one.
 *
 * It is a convenience about the browser, not a security boundary: the session itself still ends when Supabase says it does, and
 * the database checks every request. The flag holds no secret.
 */
export const SESSION_ONLY_COOKIE = "hms_session_only";

type CookieOptions = { maxAge?: number; expires?: Date | number | string; [key: string]: unknown };

/**
 * The options to write a session cookie with. Session-only drops the lifetime, but never from a cookie that is being REMOVED
 * (Supabase removes one with `maxAge: 0` or an `expires` in the past): that one must keep its lifetime or the browser would keep
 * the old cookie.
 */
export function sessionCookieOptions<T extends CookieOptions>(options: T | undefined, sessionOnly: boolean): T | undefined {
  if (!sessionOnly || !options) return options;
  if (options.maxAge !== undefined && options.maxAge <= 0) return options;
  if (options.expires !== undefined && new Date(options.expires as Date | number | string).getTime() <= Date.now()) return options;
  const rest = { ...options };
  delete rest.maxAge;
  delete rest.expires;
  return rest as T;
}

/** The flag cookie: a session cookie the page's own scripts cannot read. */
export function sessionOnlyFlagOptions(production: boolean) {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };
}

/** True when the form's "remember" checkbox was ticked (a browser sends "on"; anything else, or nothing, means not ticked). */
export function wantsRemember(value: unknown): boolean {
  return value === "on";
}
