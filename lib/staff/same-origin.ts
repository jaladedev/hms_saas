/** Cookie-authenticated POSTs are only accepted from our own pages. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}
