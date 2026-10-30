import { describe, expect, it, vi } from "vitest";
import { renderEmail, escapeHtml } from "@/lib/email/templates";
import { LogMailer, ResendMailer, createMailer } from "@/lib/email/mailer";
import { drainOutbox, type ClaimedEmail, type DrainDeps } from "@/lib/email/outbox";
import type { BookingStatus } from "@/lib/guest-site/server";

const NOW = Date.parse("2026-11-03T10:00:00Z");
const booking: BookingStatus = {
  reservation_id: "11111111-2222-3333-4444-555555555555", booking_reference: "BK-ABC123", status: "pending", payment_status: "unpaid",
  property_name: "Hotel A <Ibadan>", timezone: "Africa/Lagos", arrival_date: "2026-12-07", departure_date: "2026-12-09",
  check_in_time: "14:00:00", check_out_time: "12:00:00", currency: "NGN", total_minor: 5000000, paid_minor: 0, outstanding_minor: 5000000,
  hold_expires_at: "2026-11-03T10:20:00Z", rooms: [{ room_type: "Standard", adults: 2, children: 0 }],
};
const LINK = "https://book.hotel-a.test/booking/tok.sig";

describe("email templates", () => {
  it("held: shows the deadline in hotel time and the link, escapes HTML", () => {
    const e = renderEmail({ kind: "booking_held", booking, link: LINK, now: NOW });
    expect(e.subject).toContain("BK-ABC123");
    expect(e.text).toContain("11:20");               // 10:20 UTC is 11:20 in Lagos
    expect(e.text).toContain(LINK);
    expect(e.html).toContain("Hotel A &lt;Ibadan&gt;");
    expect(e.html).not.toContain("<Ibadan>");
    expect(e.html).toContain(`href="${LINK}"`);
  });
  it("held: says so when the hold has already lapsed", () => {
    const e = renderEmail({ kind: "booking_held", booking: { ...booking, hold_expires_at: "2026-11-03T09:00:00Z" }, link: LINK, now: NOW });
    expect(e.text).toContain("may already have expired");
  });
  it("confirmed, link and refund emails carry the right facts", () => {
    const paid = { ...booking, status: "confirmed", payment_status: "paid", paid_minor: 5000000, outstanding_minor: 0 };
    const c = renderEmail({ kind: "booking_confirmed", booking: paid, link: LINK });
    expect(c.subject).toBe("Booking confirmed: BK-ABC123");
    expect(c.text).toContain("from 14:00");
    expect(c.text).toContain("50,000.00");
    const l = renderEmail({ kind: "booking_link", booking, link: LINK });
    expect(l.text).toContain("7 days");
    const r = renderEmail({ kind: "refund_processed", booking: paid, link: LINK, payload: { amount_minor: 2500000, currency: "NGN" } });
    expect(r.text).toContain("25,000.00");
    expect(renderEmail({ kind: "refund_processed", booking: paid, link: LINK }).text).toContain("processed a refund");
  });
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("mailers", () => {
  it("ResendMailer posts the documented body with the idempotency key", async () => {
    let seen: { url?: string; headers?: Headers; body?: Record<string, unknown> } = {};
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch;
    await new ResendMailer("re_key", "Hotel <no-reply@hotel.test>", "https://api.resend.com", f).send({ to: "a@example.com", subject: "S", text: "T", html: "<p>H</p>", idempotencyKey: "row-1" });
    expect(seen.url).toBe("https://api.resend.com/emails");
    expect(seen.headers?.get("authorization")).toBe("Bearer re_key");
    expect(seen.headers?.get("idempotency-key")).toBe("row-1");
    expect(seen.body).toEqual({ from: "Hotel <no-reply@hotel.test>", to: ["a@example.com"], subject: "S", html: "<p>H</p>", text: "T" });
  });
  it("ResendMailer throws with the provider message on failure", async () => {
    const f = (async () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })) as typeof fetch;
    await expect(new ResendMailer("k", "f@x.test", undefined, f).send({ to: "a@example.com", subject: "S", text: "T", html: "H", idempotencyKey: "i" })).rejects.toThrow(/403.*domain not verified/);
    const g = (async () => new Response("<html>", { status: 502 })) as typeof fetch;
    await expect(new ResendMailer("k", "f@x.test", undefined, g).send({ to: "a@example.com", subject: "S", text: "T", html: "H", idempotencyKey: "i" })).rejects.toThrow(/502/);
  });
  it("createMailer is null unless configured, and LogMailer hides the address and body", async () => {
    expect(createMailer({})).toBeNull();
    expect(createMailer({ RESEND_API_KEY: "k" })).toBeNull();
    expect(createMailer({ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.test" })).toBeInstanceOf(ResendMailer);
    expect(createMailer({ EMAIL_TRANSPORT: "log" })).toBeInstanceOf(LogMailer);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await new LogMailer().send({ to: "guest@example.com", subject: "Hello", text: "SECRET LINK", html: "", idempotencyKey: "x" });
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("g***@example.com");
    expect(line).not.toContain("guest@");
    expect(line).not.toContain("SECRET");
    spy.mockRestore();
  });
});

function claimed(id: string, over: Partial<ClaimedEmail> = {}): ClaimedEmail {
  return { id, kind: "booking_held", to_email: `${id}@example.com`, payload: {}, attempt: 1, site_host: "book.hotel-a.test", booking, ...over };
}
function drainDeps(emails: ClaimedEmail[], over: Partial<DrainDeps> = {}) {
  const mark = vi.fn(async () => {});
  const send = vi.fn(async () => {});
  const deps: DrainDeps = { claim: vi.fn(async () => emails), mark, mailer: { send }, makeToken: (r) => `tok-${r.slice(0, 4)}`, linkScheme: "https", log: vi.fn(), ...over };
  return { deps, mark, send };
}

describe("drainOutbox", () => {
  it("sends each email with its id as idempotency key, a signed link on the hotel's domain, and marks success", async () => {
    const { deps, mark, send } = drainDeps([claimed("e1"), claimed("e2")]);
    const out = await drainOutbox(deps, 10);
    expect(out).toEqual({ claimed: 2, sent: 2, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0] as unknown as [Record<string, string>])[0];
    expect(first).toMatchObject({ to: "e1@example.com", idempotencyKey: "e1" });
    expect(first.text).toContain("https://book.hotel-a.test/booking/tok-1111");
    expect(mark).toHaveBeenCalledWith("e1", true, undefined);
  });
  it("isolates failures and reports them", async () => {
    const send = vi.fn(async (m: { to: string }) => { if (m.to.startsWith("bad")) throw new Error("provider down"); });
    const { deps, mark } = drainDeps([claimed("bad1"), claimed("good1")], { mailer: { send } });
    const out = await drainOutbox(deps, 10);
    expect(out).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(mark).toHaveBeenCalledWith("bad1", false, "provider down");
    expect(mark).toHaveBeenCalledWith("good1", true, undefined);
  });
  it("fails an email whose hotel has no verified domain without sending", async () => {
    const { deps, mark, send } = drainDeps([claimed("nodomain", { site_host: null })]);
    await drainOutbox(deps, 5);
    expect(send).not.toHaveBeenCalled();
    expect(mark).toHaveBeenCalledWith("nodomain", false, expect.stringContaining("no verified domain"));
  });
  it("survives a failure to record the result", async () => {
    const mark = vi.fn(async () => { throw new Error("db down"); });
    const { deps } = drainDeps([claimed("e1"), claimed("e2")], { mark });
    await expect(drainOutbox(deps, 10)).resolves.toMatchObject({ sent: 2 });
  });
  it("does nothing when nothing is due", async () => {
    const { deps, send } = drainDeps([]);
    expect(await drainOutbox(deps, 10)).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
