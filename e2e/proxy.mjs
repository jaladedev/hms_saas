// supabase-js talks to <url>/rest/v1/...; PostgREST serves from /. This strips the prefix.
// It also answers the one Supabase Auth call the staff pages make, GET /auth/v1/user: the bearer token must be an
// HS256 JWT signed with the same secret PostgREST uses, and the answer is the user it names. That lets the e2e test
// open staff pages with a signed session cookie, without running a real auth server.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const target = Number(process.env.POSTGREST_PORT ?? 3001);
const port = Number(process.env.PROXY_PORT ?? 3002);
const secret = process.env.PGRST_JWT_SECRET ?? "";

function userFromBearer(header) {
  const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  const parts = token?.split(".");
  if (!secret || !parts || parts.length !== 3) return null;
  const want = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (claims.role !== "authenticated" || !claims.sub || (claims.exp && claims.exp < Date.now() / 1000)) return null;
  return {
    id: claims.sub,
    aud: "authenticated",
    role: "authenticated",
    email: claims.email ?? null,
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/auth/v1/user")) {
      const user = userFromBearer(req.headers.authorization);
      res.writeHead(user ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(user ?? { code: 401, msg: "invalid token" }));
      return;
    }
    const path = req.url.replace(/^\/rest\/v1/, "") || "/";
    const upstream = http.request({ host: "127.0.0.1", port: target, path, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(port, "127.0.0.1", () => console.log(`proxy on ${port}`));
