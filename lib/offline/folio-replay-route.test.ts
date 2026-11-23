import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { fn: string; args: Record<string, unknown> }[] = [];
let user: { id: string } | null = { id: "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10" };
let rpcError: (fn: string, args: Record<string, unknown>) => string | null = () => null;
const revalidated: string[] = [];

vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.push(p) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      const message = rpcError(fn, args);
      return { error: message ? { message } : null };
    },
  }),
}));

const { POST } = await import("@/app/api/staff/folio/replay/route");

const ME = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const OTHER = "7f3e2a10-1b4c-4d5e-8f60-a1b2c3d4e5f6";
const R1 = "11111111-2222-4333-8444-555555555555";
const R2 = "22222222-3333-4444-8555-666666666666";
const post = (body: unknown, type = "application/json") =>
  POST(new Request("http://x/api/staff/folio/replay", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) }));

const charge = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  action: "folio_charge",
  userId: ME,
  reservationId: R1,
  fields: { category: "minibar", description: "2 bottles of water", quantity: "2", amount: "1,500", date: "2026-11-22" },
  ...over,
});
const payment = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  action: "folio_payment",
  userId: ME,
  reservationId: R1,
  fields: { amount: "3000", method: "cash", reference: "R-77", note: "paid at desk" },
  madeAt: "2026-11-23T14:05:44.000Z",
  ...over,
});

beforeEach(() => {
  // The route never states a time in the future, so the tests pin the clock after the times they use.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-23T15:00:00Z") });
  calls.length = 0;
  revalidated.length = 0;
  user = { id: ME };
  rpcError = () => null;
});

afterEach(() => vi.useRealTimers());

describe("POST /api/staff/folio/replay", () => {
  it("refuses a signed-out caller, a non-JSON body and a malformed body", async () => {
    user = null;
    expect((await post({ items: [charge()] })).status).toBe(401);
    user = { id: ME };
    expect((await post({ items: [] }, "text/plain")).status).toBe(415);
    expect((await post({ items: [charge({ action: "folio_void" })] })).status).toBe(400);
    expect((await post({ items: [charge({ reservationId: "x" })] })).status).toBe(400);
    expect((await post("nonsense")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("posts a charge through the folio function, as the person, with the item's id as the key and the chosen day as the date", async () => {
    const c = charge();
    const res = await post({ items: [c] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([
      {
        fn: "post_folio_charge",
        args: {
          p_reservation_id: R1,
          p_category: "minibar",
          p_description: "2 bottles of water",
          p_quantity: 2,
          p_unit_amount_minor: 150000,
          p_idempotency_key: c.id,
          p_charge_date: "2026-11-22",
          p_reservation_room_id: null,
        },
      },
    ]);
    expect((await res.json()).results).toEqual([{ id: c.id, status: "done" }]);
    expect(revalidated).toEqual([`/app/reservations/${R1}`]);
  });

  it("records a payment with the item's id as the key and the time it was really taken written into the note", async () => {
    const p = payment();
    await post({ items: [p] });
    expect(calls).toEqual([
      {
        fn: "record_folio_payment",
        args: {
          p_reservation_id: R1,
          p_amount_minor: 300000,
          p_method: "cash",
          p_reference: "R-77",
          p_note: "paid at desk · Taken offline at 2026-11-23 14:05 UTC",
          p_idempotency_key: p.id,
        },
      },
    ]);
  });

  it("never reads a key from the form's fields, so two changes from one saved page copy cannot share one", async () => {
    const a = charge({ fields: { ...charge().fields, idempotencyKey: "from-the-page" } });
    const b = charge({ fields: { ...charge().fields, idempotencyKey: "from-the-page" } });
    await post({ items: [a, b] });
    expect(calls.map((c) => c.args.p_idempotency_key)).toEqual([a.id, b.id]);
    expect(new Set(calls.map((c) => c.args.p_idempotency_key)).size).toBe(2);
  });

  it("sends the same key again when the same change is sent twice, so the database answers with the first answer", async () => {
    const c = charge();
    await post({ items: [c] });
    await post({ items: [c] });
    expect(calls.map((x) => x.args.p_idempotency_key)).toEqual([c.id, c.id]);
  });

  it("runs the changes in the order they were sent and answers each one", async () => {
    const a = charge(),
      b = payment({ reservationId: R2 }),
      c = charge({ reservationId: R2 });
    const res = await post({ items: [a, b, c] });
    expect(calls.map((x) => [x.fn, x.args.p_reservation_id])).toEqual([
      ["post_folio_charge", R1],
      ["record_folio_payment", R2],
      ["post_folio_charge", R2],
    ]);
    expect((await res.json()).results.map((r: { status: string }) => r.status)).toEqual(["done", "done", "done"]);
    expect(new Set(revalidated)).toEqual(new Set([`/app/reservations/${R1}`, `/app/reservations/${R2}`]));
  });

  it("does not run an item saved by someone else on the computer, and goes on with the rest", async () => {
    const theirs = charge({ userId: OTHER }),
      mine = charge();
    const res = await post({ items: [theirs, mine] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.p_idempotency_key).toBe(mine.id);
    expect((await res.json()).results).toEqual([
      { id: theirs.id, status: "rejected", reason: "other_user" },
      { id: mine.id, status: "done" },
    ]);
  });

  it("refuses a form that does not read, without calling the database", async () => {
    const bad = charge({ fields: { category: "casino", description: "x", quantity: "1", amount: "5" } });
    const badPay = payment({ fields: { amount: "10", method: "bitcoin" } });
    const res = await post({ items: [bad, badPay] });
    expect(calls).toEqual([]);
    expect((await res.json()).results).toEqual([
      { id: bad.id, status: "rejected", reason: "invalid" },
      { id: badPay.id, status: "rejected", reason: "invalid" },
    ]);
    expect(revalidated).toEqual([]);
  });

  it("explains a refusal in fixed words and does not refresh a booking nothing was done to", async () => {
    rpcError = (fn) => (fn === "record_folio_payment" ? "POLICY_VIOLATION: OVERPAYMENT outstanding 500" : "INVALID_STATE: cancelled");
    const p = payment(),
      c = charge();
    const res = await post({ items: [p, c] });
    expect((await res.json()).results).toEqual([
      { id: p.id, status: "rejected", reason: "overpay" },
      { id: c.id, status: "rejected", reason: "not_open" },
    ]);
    expect(revalidated).toEqual([]);
  });

  it("asks for a retry when the failure is not one it knows", async () => {
    rpcError = () => "connection terminated unexpectedly";
    const c = charge();
    expect((await (await post({ items: [c] })).json()).results).toEqual([{ id: c.id, status: "retry" }]);
  });

  it("leaves the note alone when no time came with the payment", async () => {
    await post({ items: [payment({ madeAt: undefined })] });
    expect(calls[0]?.args.p_note).toBe("paid at desk");
  });
});
