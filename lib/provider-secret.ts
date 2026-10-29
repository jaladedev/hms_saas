/**
 * payment_provider_accounts.secret_reference is a pointer, never a secret. Supported form:
 * "env:VARIABLE_NAME" (an upper-case environment variable). Throws when the pointer is malformed
 * or the variable is missing or too short, so callers fail closed.
 */
export function resolveProviderSecret(secretReference: string, env: Record<string, string | undefined> = process.env): string {
  const match = /^env:([A-Z][A-Z0-9_]*)$/.exec(secretReference);
  const value = match?.[1] ? env[match[1]] : undefined;
  if (!value || value.length < 8) throw new Error("secret not available");
  return value;
}
