import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { POST } = await import("@/app/api/staff/housekeeping/replay/route");

const ME = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const OTHER = "7f3e2a10-1b4c-4d5e-8f60-a1b2c3d4e5f6";
const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "22222222-3333-4444-8555-666666666666";
const post = (body: unknown, type = "application/json") =>
  POST(
    new Request("http://x/api/staff/housekeeping/replay", {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify(body),
    }),
  );
const it1 = (over: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), action: "start", taskId: T1, userId: ME, ...over });

beforeEach(() => {
  calls.length = 0;
  revalidated.length = 0;
  user = { id: ME };
  rpcError = () => null;
});

describe("POST /api/staff/housekeeping/replay", () => {
  it("refuses a signed-out caller, a non-JSON body and a malformed body", async () => {
    user = null;
    expect((await post({ items: [it1()] })).status).toBe(401);
    user = { id: ME };
    expect((await post({ items: [] }, "text/plain")).status).toBe(415);
    expect((await post({ items: [{ ...it1(), action: "cancel" }] })).status).toBe(400);
    expect((await post("nonsense")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("runs each step as the person through the same database functions, in order", async () => {
    const a = it1({ action: "claim" }),
      b = it1({ action: "start" }),
      c = it1({ action: "complete", note: "  done  " });
    const res = await post({ items: [a, b, c] });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([
      { fn: "claim_housekeeping_task", args: { p_task_id: T1, p_at: null } },
      { fn: "start_housekeeping_task", args: { p_task_id: T1, p_at: null } },
      { fn: "complete_housekeeping_task", args: { p_task_id: T1, p_note: "done", p_at: null } },
    ]);
    const { results } = await res.json();
    expect(results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      [a.id, "done"],
      [b.id, "done"],
      [c.id, "done"],
    ]);
    expect(revalidated).toEqual(["/app/housekeeping", "/app/maintenance", "/app/rooms"]);
  });

  it("passes the time each change was made to its database function", async () => {
    const t1 = "2026-11-23T10:42:00.000Z",
      t2 = "2026-11-23T10:55:30+01:00";
    await post({
      items: [
        it1({ action: "claim", madeAt: t1 }),
        it1({ action: "start", madeAt: t1 }),
        it1({ action: "complete", note: "ok", madeAt: t2 }),
      ],
    });
    expect(calls).toEqual([
      { fn: "claim_housekeeping_task", args: { p_task_id: T1, p_at: t1 } },
      { fn: "start_housekeeping_task", args: { p_task_id: T1, p_at: t1 } },
      { fn: "complete_housekeeping_task", args: { p_task_id: T1, p_note: "ok", p_at: t2 } },
    ]);
  });

  it("runs a repair step through its own database function, with the time it was made", async () => {
    const t = "2026-11-23T10:42:00.000Z";
    await post({
      items: [
        it1({ action: "maint_claim", madeAt: t }),
        it1({ action: "maint_start", madeAt: t }),
        it1({ action: "maint_resolve", note: "  replaced the tap  ", madeAt: t }),
      ],
    });
    expect(calls).toEqual([
      { fn: "claim_maintenance_request", args: { p_request_id: T1, p_at: t } },
      { fn: "start_maintenance_request", args: { p_request_id: T1, p_at: t } },
      { fn: "resolve_maintenance_request", args: { p_request_id: T1, p_note: "replaced the tap", p_at: t } },
    ]);
  });

  it("refuses a made-at that is not a date, and sends no time when none was given", async () => {
    expect((await post({ items: [it1({ madeAt: "yesterday" })] })).status).toBe(400);
    expect((await post({ items: [it1({ madeAt: "2026-11-23" })] })).status).toBe(400);
    expect(calls).toEqual([]);
    await post({ items: [it1()] });
    expect(calls[0]?.args.p_at).toBeNull();
  });

  it("never runs a change that another person saved on this computer", async () => {
    const mine = it1(),
      theirs = it1({ userId: OTHER, taskId: T2 });
    const { results } = await (await post({ items: [theirs, mine] })).json();
    expect(results[0]).toEqual({ id: theirs.id, status: "rejected", reason: "other_user" });
    expect(results[1].status).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ p_task_id: T1, p_at: null });
  });

  it("reports each refusal separately and never shows database text", async () => {
    rpcError = (_fn, args) =>
      args.p_task_id === T1 ? "FORBIDDEN: assigned to someone else" : args.p_task_id === T2 ? "INVALID_STATE: task done" : null;
    const a = it1(),
      b = it1({ taskId: T2 }),
      c = it1({ taskId: "33333333-4444-4555-8666-777777777777" });
    const res = await post({ items: [a, b, c] });
    const text = await res.clone().text();
    expect(text).not.toMatch(/FORBIDDEN|INVALID_STATE/);
    const { results } = await res.json();
    expect(results).toEqual([
      { id: a.id, status: "rejected", reason: "taken" },
      { id: b.id, status: "already" },
      { id: c.id, status: "done" },
    ]);
  });

  it("does not refresh the pages when nothing was applied", async () => {
    rpcError = () => "connection terminated unexpectedly";
    const { results } = await (await post({ items: [it1()] })).json();
    expect(results[0].status).toBe("retry");
    expect(revalidated).toEqual([]);
  });
});
