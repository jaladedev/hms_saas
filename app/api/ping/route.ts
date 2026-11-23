// A tiny public answer the staff pages use to tell "the connection works" from "the Wi-Fi is up but the internet is not"
// (navigator.onLine cannot tell those apart). It reads nothing and returns nothing.
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export function HEAD() {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
