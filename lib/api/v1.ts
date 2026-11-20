import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { bearerKey, hashApiKey, parseAuth, type AuthResult } from "./keys";

type Ctx = { keyId: string; propertyId: string; scopes: string[] };
type Handler = (ctx: Ctx, url: URL) => Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** Maps a database refusal to an API answer. Raw database text is never returned. */
export function apiErrorFor(message: string): Response {
  if (/NOT_FOUND/.test(message)) return json(404, { error: "not_found" });
  if (/INVALID_STATE: no booking site/.test(message))
    return json(409, {
      error: "no_booking_site",
      message: "This hotel has no verified booking website, so availability cannot be answered.",
    });
  if (/POLICY_VIOLATION/.test(message))
    return json(400, { error: "invalid_request", message: message.replace(/^.*POLICY_VIOLATION: /s, "").slice(0, 120) });
  return json(500, { error: "server_error" });
}

/**
 * Wraps one /api/v1 route: checks the bearer key, the scope and the rate limit (all in the database), runs the handler, and logs the call
 * (method, path without its query string, status) against the key. A key that is wrong, revoked or for a hotel whose plan lost API access
 * always gets the same 401, so nothing is learned from the answer.
 */
export async function apiRoute(request: Request, scope: string, handler: Handler): Promise<Response> {
  const key = bearerKey(request.headers.get("authorization"));
  if (!key) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  const db = createServiceClient();
  const { data, error } = await db.rpc("api_key_authenticate", { p_hash: hashApiKey(key) });
  if (error) return json(500, { error: "server_error" });
  const auth: AuthResult = parseAuth(data);
  if (!auth.ok) {
    if (auth.reason === "rate_limited") return json(429, { error: "rate_limited" }, { "retry-after": String(auth.retryAfter ?? 60) });
    return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }
  const url = new URL(request.url);
  let response: Response;
  if (!auth.scopes.includes(scope)) response = json(403, { error: "forbidden", message: `This key needs the ${scope} scope.` });
  else {
    try {
      response = await handler({ keyId: auth.keyId, propertyId: auth.propertyId, scopes: auth.scopes }, url);
    } catch {
      response = json(500, { error: "server_error" });
    }
  }
  await db.rpc("api_log_call", { p_key: auth.keyId, p_method: request.method, p_path: url.pathname, p_status: response.status });
  return response;
}

export { json as apiJson };
