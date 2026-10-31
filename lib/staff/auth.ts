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

/**
 * Where the email-link callback may send someone: the reset-password page, or a path inside /app.
 * Same open-redirect rule as safeNext.
 */
export function callbackTarget(next: string | null | undefined): string {
  return next === "/reset-password" ? next : safeNext(next);
}

/** Notices shown on the sign-in page, from ?ok=. */
export function signInNotice(code: string | undefined): string | null {
  return code === "reset" ? "Your password was changed. Sign in with the new one." : null;
}

export type PasswordProblem = "mismatch" | "short" | "long";
export const MIN_PASSWORD_LENGTH = 10;
/** Supabase hashes passwords with bcrypt, which ignores everything past 72 bytes: refuse rather than silently truncate. */
export const MAX_PASSWORD_BYTES = 72;

export function validateNewPassword(password: string, confirm: string): PasswordProblem | null {
  if (password !== confirm) return "mismatch";
  if (password.length < MIN_PASSWORD_LENGTH) return "short";
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return "long";
  return null;
}

export type ResetErrorCode = PasswordProblem | "same" | "weak" | "expired" | "unavailable";

export function resetErrorMessage(code: string | undefined): string | null {
  switch (code as ResetErrorCode | undefined) {
    case undefined: return null;
    case "mismatch": return "The two passwords are not the same.";
    case "short": return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "long": return "That password is too long. Use 72 bytes or fewer (about 72 characters, fewer if it has accents or symbols).";
    case "same": return "Choose a password you have not used for this account before.";
    case "weak": return "That password is too easy to guess. Add more characters or a few unrelated words.";
    case "expired": return "This link has expired or was already used. Ask for a new one.";
    default: return "Something went wrong, and your password was not changed. Try again in a moment.";
  }
}

/** Maps what Supabase Auth reported when setting a password. Never echoes its message to the browser. */
export function classifyUpdateError(error: { status?: number | undefined; code?: string | undefined }): ResetErrorCode {
  if (error.code === "same_password") return "same";
  if (error.code === "weak_password") return "weak";
  if (error.status === 401 || error.status === 403 || /session/.test(error.code ?? "")) return "expired";
  return "unavailable";
}

/** The host we are served on, for the recovery link. Supabase also checks the link against its own allow-list. */
export function siteOrigin(headers: { get(name: string): string | null }, production: boolean): string | null {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]?.trim() ?? "";
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host)) return null;
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  return `${proto === "http" || proto === "https" ? proto : production ? "https" : "http"}://${host}`;
}
