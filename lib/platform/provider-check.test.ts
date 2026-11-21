import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ERROR_MESSAGES, OK_MESSAGES } from "@/lib/platform/hotel";
import { CHECK_OUTCOMES, checkPaystackAccount, keyModeOf, outcomeNotice, type CheckOutcome } from "@/lib/platform/provider-check";

const TEST_KEY = "sk_test_abcdef1234567890";
const LIVE_KEY = "sk_live_abcdef1234567890";
const env = { PAYSTACK_TEST: TEST_KEY, PAYSTACK_LIVE: LIVE_KEY, ODD: "not-a-paystack-key-at-all", SHORT: "abc" };
const test = { mode: "test", secretReference: "env:PAYSTACK_TEST" };

const reply = (status: number, body: unknown): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("keyModeOf", () => {
  it("accepts only Paystack secret keys and says which mode they are", () => {
    expect(keyModeOf(TEST_KEY)).toBe("test");
    expect(keyModeOf(LIVE_KEY)).toBe("live");
    for (const v of [
      "pk_test_abcdef1234567890",
      "sk_test_short",
      "sk_stage_abcdef1234567890",
      "xsk_test_abcdef1234567890",
      "",
      "sk_test_abc def12345",
    ]) {
      expect(keyModeOf(v)).toBeNull();
    }
  });
});

describe("checkPaystackAccount", () => {
  it("is ok when Paystack accepts the key, with one read-only GET that carries the key as a bearer token", async () => {
    const fetchFn = reply(200, { status: true, data: [{ id: 1, name: "A Bank" }] });
    expect(await checkPaystackAccount(test, env, fetchFn)).toEqual({ outcome: "ok", keyMode: "test" });
    const mock = fetchFn as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/bank\?/);
    expect(new URL(url).searchParams.get("perPage")).toBe("1");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it("checks a live account with a live key", async () => {
    const r = await checkPaystackAccount(
      { mode: "live", secretReference: "env:PAYSTACK_LIVE" },
      env,
      reply(200, { status: true, data: [] }),
    );
    expect(r).toEqual({ outcome: "ok", keyMode: "live" });
  });

  it("reports a missing, short or malformed pointer as no_secret without calling Paystack", async () => {
    for (const secretReference of ["env:NOT_SET", "env:SHORT", "vault://x", "", "env:lower"]) {
      const fetchFn = reply(200, {});
      expect(await checkPaystackAccount({ mode: "test", secretReference }, env, fetchFn)).toEqual({ outcome: "no_secret", keyMode: null });
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it("reports a value that is not a Paystack secret key as bad_key without calling Paystack", async () => {
    const fetchFn = reply(200, {});
    expect(await checkPaystackAccount({ mode: "test", secretReference: "env:ODD" }, env, fetchFn)).toEqual({
      outcome: "bad_key",
      keyMode: null,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never sends a key to Paystack when its mode is not the account's mode", async () => {
    const live = vi.fn();
    expect(
      await checkPaystackAccount({ mode: "live", secretReference: "env:PAYSTACK_TEST" }, env, live as unknown as typeof fetch),
    ).toEqual({
      outcome: "mode_mismatch",
      keyMode: "test",
    });
    expect(
      await checkPaystackAccount({ mode: "test", secretReference: "env:PAYSTACK_LIVE" }, env, live as unknown as typeof fetch),
    ).toEqual({
      outcome: "mode_mismatch",
      keyMode: "live",
    });
    expect(live).not.toHaveBeenCalled();
  });

  it("is rejected on 401 and 403", async () => {
    for (const status of [401, 403]) {
      expect(await checkPaystackAccount(test, env, reply(status, { status: false, message: "Invalid key" }))).toEqual({
        outcome: "rejected",
        keyMode: "test",
      });
    }
  });

  it("concludes nothing about the key on a rate limit, a server error, a timeout or a network failure", async () => {
    for (const status of [404, 429, 500, 502, 503]) {
      expect((await checkPaystackAccount(test, env, reply(status, {}))).outcome).toBe("unreachable");
    }
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect((await checkPaystackAccount(test, env, down)).outcome).toBe("unreachable");
    const timedOut = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof fetch;
    expect((await checkPaystackAccount(test, env, timedOut)).outcome).toBe("unreachable");
  });

  it("is unexpected when Paystack answers 200 in a shape the app does not know", async () => {
    for (const body of [{ status: false, data: [] }, { status: true }, { status: true, data: "banks" }, null, [], "ok"]) {
      expect((await checkPaystackAccount(test, env, reply(200, body))).outcome).toBe("unexpected");
    }
    const notJson = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch;
    expect((await checkPaystackAccount(test, env, notJson)).outcome).toBe("unexpected");
  });

  it("never puts the key in its result, whatever the outcome", async () => {
    const answers: (typeof fetch)[] = [
      reply(200, { status: true, data: [] }),
      reply(401, { message: `bad key ${TEST_KEY}` }),
      reply(500, {}),
      reply(200, { status: false, message: TEST_KEY }),
    ];
    for (const a of answers) {
      const text = JSON.stringify(await checkPaystackAccount(test, env, a));
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain("sk_");
    }
  });
});

describe("outcomeNotice", () => {
  it("gives every outcome exactly one worded notice: ok for ok, a refusal for the rest", () => {
    for (const outcome of CHECK_OUTCOMES) {
      const n = outcomeNotice(outcome);
      if (outcome === "ok") {
        expect(n).toEqual({ ok: "check_ok" });
        expect(OK_MESSAGES.check_ok.length).toBeGreaterThan(10);
      } else {
        expect("err" in n).toBe(true);
        if ("err" in n) expect(ERROR_MESSAGES[n.err].length).toBeGreaterThan(10);
      }
    }
    const codes = CHECK_OUTCOMES.filter((o) => o !== "ok").map((o) => JSON.stringify(outcomeNotice(o)));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("does not say the key worked unless Paystack accepted it", () => {
    for (const o of CHECK_OUTCOMES.filter((x): x is Exclude<CheckOutcome, "ok"> => x !== "ok")) {
      expect("ok" in outcomeNotice(o)).toBe(false);
    }
  });
});

describe("migration 169", () => {
  const sql = readFileSync("supabase/migrations/20261026000169_provider_check.sql", "utf8");
  it("accepts exactly the outcomes the app can produce", () => {
    const list = /p_outcome not in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const words = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(words.sort()).toEqual([...CHECK_OUTCOMES].sort());
  });
  it("stores no secret: the audit row carries only the outcome, the account's mode and the key's mode", () => {
    const meta = /jsonb_build_object\('outcome'[^;]*;/.exec(sql)?.[0] ?? "";
    expect(meta).toContain("'outcome'");
    expect(meta).toContain("'key_mode'");
    expect(meta).not.toMatch(/secret|payload|message|error/i);
  });
});
