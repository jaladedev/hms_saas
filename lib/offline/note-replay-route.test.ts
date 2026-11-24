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

const { POST } = await import("@/app/api/staff/reservation-note/replay/route");

const ME = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const OTHER = "7f3e2a10-1b4c-4d5e-8f60-a1b2c3d4e5f6";
const R1 = "11111111-2222-4333-8444-555555555555";
const R2 = "22222222-3333-4444-8555-666666666666";
const post = (body: unknown, type = "application/json") =>
  POST(
    new Request("http://x/api/staff/reservation-note/replay", {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify(body),
    }),
  );
const note = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  action: "note_set",
  userId: ME,
  reservationId: R1,
  note: "Arrives late, will call",
  expected: "Paying by transfer",
  madeAt: "2026-11-23T14:05:44.000Z",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  revalidated.length = 0;
  user = { id: ME };
  rpcError = () => null;
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/staff/reservation-note/replay", () => {
  it("refuses a signed-out caller, a non-JSON body and a malformed body", async () => {
    user = null;
    expect((await post({ items: [note()] })).status).toBe(401);
    user = { id: ME };
    expect((await post({ items: [note()] }, "text/plain")).status).toBe(415);
    expect((await post({ items: [{ ...note(), action: "folio_charge" }] })).status).toBe(400);
    expect((await post({ items: [{ ...note(), expected: undefined }] })).status).toBe(400);
    expect((await post("nope")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("saves each note through the compare-and-set function, with the text it replaced and the time it was saved", async () => {
    const a = note(),
      b = note({ reservationId: R2, note: "", expected: "Old note", madeAt: undefined });
    const res = await post({ items: [a, b] });
    expect(await res.json()).toEqual({
      results: [
        { id: a.id, status: "done" },
        { id: b.id, status: "done" },
      ],
    });
    expect(calls).toEqual([
      {
        fn: "set_reservation_note_if_unchanged",
        args: { p_reservation: R1, p_note: "Arrives late, will call", p_expected: "Paying by transfer", p_at: "2026-11-23T14:05:44.000Z" },
      },
      { fn: "set_reservation_note_if_unchanged", args: { p_reservation: R2, p_note: "", p_expected: "Old note", p_at: null } },
    ]);
    expect(revalidated.sort()).toEqual([`/app/reservations/${R1}`, `/app/reservations/${R2}`]);
  });

  it("reports a note changed by someone else as refused, so the app can keep the text", async () => {
    rpcError = () => "CONFLICT: staff note changed";
    const a = note();
    expect(await (await post({ items: [a] })).json()).toEqual({ results: [{ id: a.id, status: "rejected", reason: "changed" }] });
    expect(revalidated).toEqual([]);
  });

  it("classifies the other refusals and retries what it does not know", async () => {
    const msgs = ["NOT_FOUND", "POLICY_VIOLATION: staff note", "fetch failed"];
    rpcError = (_fn, _args) => msgs[calls.length - 1] ?? null;
    const items = [note(), note(), note()];
    const { results } = (await (await post({ items })).json()) as { results: { status: string; reason?: string }[] };
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["rejected", "no_access"],
      ["rejected", "invalid"],
      ["retry", undefined],
    ]);
  });

  it("never runs a note that another person saved on this computer", async () => {
    const mine = note(),
      theirs = note({ userId: OTHER });
    const { results } = (await (await post({ items: [theirs, mine] })).json()) as {
      results: { id: string; status: string; reason?: string }[];
    };
    expect(results[0]).toEqual({ id: theirs.id, status: "rejected", reason: "other_user" });
    expect(results[1]).toEqual({ id: mine.id, status: "done" });
    expect(calls).toHaveLength(1);
  });
});
