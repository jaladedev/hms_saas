// supabase-js talks to <url>/rest/v1/...; PostgREST serves from /. This strips the prefix.
import http from "node:http";

const target = Number(process.env.POSTGREST_PORT ?? 3001);
const port = Number(process.env.PROXY_PORT ?? 3002);

http.createServer((req, res) => {
  const path = req.url.replace(/^\/rest\/v1/, "") || "/";
  const upstream = http.request({ host: "127.0.0.1", port: target, path, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
}).listen(port, "127.0.0.1", () => console.log(`proxy on ${port}`));
