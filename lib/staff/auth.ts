/** Rules for staff sign-in. Pure functions, tested without a server. */

/**
 * Where to send someone after signing in. Only paths inside /app are allowed, so a crafted
 * /login?next=https://evil.example (or //evil.example, or /\evil.example) cannot bounce a signed-in
 * person to another site. Anything else falls back to the dashboard.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value || value.length > 500) return "/app";
  if (!/^\/app(?:[/?#]|$)/.test(value)) return "/app";
  if (/[\\\s\u0000-\u001f]/.test(value) || value.includes("//")) return "/app";
  return value;
}

export type SignInErrorCode = "invalid" | "no_access" | "rate" | "unavailable";

export function signInErrorMessage(code: string | undefined): string | null {
  switch (code as SignInErrorCode | undefined) {
    case undefined: return null;
    // Deliberately the same for an unknown email and a wrong password.
    case "invalid": return "That email and password do not match an account.";
    case "no_access": return "This account is not active at any hotel. Ask the owner to check your access.";
    case "rate": return "Too many attempts. Wait a few minutes and try again.";
    case "unavailable": return "Sign-in is not available right now. Try again in a moment.";
    default: return "That email and password do not match an account.";
  }
}

/** Maps what Supabase Auth reported to a code the page can word. Never echoes its message to the browser. */
export function classifyAuthError(error: { status?: number | undefined; name?: string | undefined }): SignInErrorCode {
  if (error.status === 429) return "rate";
  if ((error.status !== undefined && error.status >= 500) || error.status === undefined || /retryable|fetch/i.test(error.name ?? "")) {
    return "unavailable";
  }
  return "invalid";
}
