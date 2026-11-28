import { beforeEach, describe, expect, it, vi } from "vitest";

const PROP = "11111111-2222-4333-8444-555555555555";
let user: { id: string } | null = { id: "u1" };
let property: { id: string; name: string; timezone: string } | null = { id: PROP, name: "Hotel Ibadan", timezone: "Africa/Lagos" };
let mayExport: boolean | null = true;
/** how many rows the database holds for the period, or an error to return */
let total = 0;
let failAt: { page: number; message: string } | null = null;
const ledgerCalls: { args: Record<string, unknown>; from: number; to: number }[] = [];
const rpcCalls: string[] = [];

const rowAt = (i: number) => ({
  entry_at: "2026-11-24T14:05:00+00:00",
  entry_day: "2026-11-24",
  kind: "booking_payment",
  internal_reference: `PAY-${String(i).padStart(6, "0")}`,
  provider_reference: null,
  booking_reference: `BK-${i}`,
  guest_name: "Ada",
  method: "cash",
  provider: null,
  group_reference: null,
  amount_minor: 100,
  currency: "NGN",
  note: null,
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: property }) }) }) }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(fn);
      if (fn === "has_permission") return Promise.resolve({ data: mayExport });
      return {
        range: async (from: number, to: number) => {
          ledgerCalls.push({ args, from, to });
          if (failAt && ledgerCalls.length - 1 === failAt.page) return { data: null, error: { message: failAt.message } };
          const data = Array.from({ length: Math.max(0, Math.min(to + 1, total) - from) }, (_, k) => rowAt(from + k));
          return { data, error: null };
        },
      };
    },
  }),
}));

const { GET } = await import("@/app/api/staff/ledger/route");
const get = (qs = `property=${PROP}&from=2026-11-01&to=2026-11-24`) => GET(new Request(`http://x/api/staff/ledger?${qs}`));

beforeEach(() => {
  user = { id: "u1" };
  property = { id: PROP, name: "Hotel Ibadan", timezone: "Africa/Lagos" };
  mayExport = true;
  total = 3;
  failAt = null;
  ledgerCalls.length = 0;
  rpcCalls.length = 0;
});

describe("GET /api/staff/ledger", () => {
  it("needs a signed-in person, a hotel they can see and the export right, and reads no money before that", async () => {
    user = null;
    expect((await get()).status).toBe(401);
    user = { id: "u1" };
    property = null;
    expect((await get()).status).toBe(404);
    property = { id: PROP, name: "Hotel Ibadan", timezone: "Africa/Lagos" };
    mayExport = false;
    expect((await get()).status).toBe(404);
    mayExport = null;
    expect((await get()).status).toBe(404);
    expect(rpcCalls).not.toContain("money_ledger");
    expect(ledgerCalls).toEqual([]);
  });

  it("sends the file with the hotel and period in its name, as an attachment that is never cached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ledger-hotel-ibadan-2026-11-01-to-2026-11-24.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const lines = (await res.text()).trimEnd().split("\n");
    expect(lines).toHaveLength(1 + 3);
    expect(lines[1]).toContain("PAY-000000");
  });

  it("asks the database for this hotel and this period", async () => {
    await get();
    expect(ledgerCalls[0]?.args).toEqual({ p_property: PROP, p_from: "2026-11-01", p_to: "2026-11-24" });
  });

  it("reads a long period in pages of 1000 and keeps every row, in order, once", async () => {
    total = 2500;
    const res = await get();
    expect(ledgerCalls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    const lines = (await res.text()).trimEnd().split("\n").slice(1);
    expect(lines).toHaveLength(2500);
    expect(lines[0]).toContain("PAY-000000");
    expect(lines[1499]).toContain("PAY-001499");
    expect(lines[2499]).toContain("PAY-002499");
    expect(new Set(lines.map((l) => l.split(",")[7])).size).toBe(2500);
  });

  it("asks once more when a page is exactly full, and stops on the empty page", async () => {
    total = 1000;
    const res = await get();
    expect(ledgerCalls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect((await res.text()).trimEnd().split("\n")).toHaveLength(1 + 1000);
  });

  it("makes a header-only file for a period with no money in it", async () => {
    total = 0;
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.text()).trimEnd().split("\n")).toHaveLength(1);
  });

  it("refuses a period too big for one file, saying so, instead of sending part of it", async () => {
    total = 1_000_000;
    const res = await get();
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toMatch(/too many payments/i);
    expect(ledgerCalls.length).toBe(50);
  });

  it("never sends a partial file when a later page fails", async () => {
    total = 2500;
    failAt = { page: 1, message: "connection terminated" };
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/try again/i);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("tells a refusal by the database from a failure, so a failure is not shown as 'not found'", async () => {
    failAt = { page: 0, message: "NOT_FOUND" };
    expect((await get()).status).toBe(404);
    ledgerCalls.length = 0; // the mock picks the failing page from this count, so each request starts from zero
    failAt = { page: 0, message: "could not connect to server" };
    expect((await get()).status).toBe(500);
  });

  it("keeps to the report's period: a bad or missing range becomes the last week, a long one the last 92 days", async () => {
    await get(`property=${PROP}&from=nonsense&to=2026-11-24`);
    const week = ledgerCalls.at(-1)!.args;
    expect(week.p_from).not.toBe("nonsense");
    expect((Date.parse(String(week.p_to)) - Date.parse(String(week.p_from))) / 86_400_000).toBe(6);
    ledgerCalls.length = 0;
    await get(`property=${PROP}&from=2025-01-01&to=2026-11-24`);
    const long = ledgerCalls[0]!.args;
    expect(long.p_to).toBe("2026-11-24");
    expect((Date.parse(String(long.p_to)) - Date.parse(String(long.p_from))) / 86_400_000).toBe(91);
  });
});
