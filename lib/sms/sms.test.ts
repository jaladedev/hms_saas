import { describe, expect, it, vi } from "vitest";
import { LogSmsProvider, SmsSendError, TermiiProvider, createSmsProvider, isPermanentRefusal, type SmsProvider } from "@/lib/sms/provider";
import { drainSms, type ClaimedSms } from "@/lib/sms/outbox";
import { gsmSafe, renderSms, smsParts } from "@/lib/sms/templates";
import type { BookingStatus } from "@/lib/guest-site/server";

const booking: BookingStatus = {
  reservation_id: "11111111-2222-3333-4444-555555555555",
  booking_reference: "BK-ABC123",
  status: "confirmed",
  payment_status: "paid",
  property_name: "Hôtel Á <Ibadan> Grand",
  timezone: "Africa/Lagos",
  arrival_date: "2026-12-07",
  departure_date: "2026-12-09",
  check_in_time: "14:00:00",
  check_out_time: "12:00:00",
  currency: "NGN",
  total_minor: 5000000,
  paid_minor: 5000000,
  outstanding_minor: 0,
  hold_expires_at: null,
  rooms: [{ room_type: "Standard", adults: 2, children: 0 }],
};
const base = { booking, hotelPhone: "+234 803 111 0000", siteHost: "book.hotel-a.test", scheme: "https" as const };

describe("sms templates", () => {
  it("confirmed: reference, short dates, check-in time, lookup page; no signed link", () => {
    const t = renderSms({ ...base, kind: "booking_confirmed" });
    expect(t).toBe(
      "Hotel A <Ibadan> Grand: booking BK-ABC123 confirmed, 7 Dec to 9 Dec. Check-in from 14:00. Details: https://book.hotel-a.test/booking/find",
    );
    expect(t).not.toContain("/booking/ey");
    expect(smsParts(t)).toBeLessThanOrEqual(2);
  });
  it("reminder: arrival, check-in time and the hotel's number; the number is left out when there is none", () => {
    expect(renderSms({ ...base, kind: "arrival_reminder" })).toBe(
      "Hotel A <Ibadan> Grand: see you on 7 Dec! Check-in from 14:00. Booking BK-ABC123. Call +234 803 111 0000.",
    );
    expect(renderSms({ ...base, hotelPhone: null, kind: "arrival_reminder" })).not.toContain("Call");
  });
  it("review request: asks for a rating and gives the reference", () => {
    const t = renderSms({ ...base, kind: "review_request" });
    expect(t).toContain("thank you for staying");
    expect(t).toContain("https://book.hotel-a.test/booking/find");
    expect(t).toContain("(booking BK-ABC123)");
  });
  it("leaves the link out when the host is missing or not a host name", () => {
    expect(renderSms({ ...base, siteHost: null, kind: "booking_confirmed" })).not.toContain("http");
    expect(renderSms({ ...base, siteHost: "evil.test/x?y=z", kind: "booking_confirmed" })).not.toContain("http");
    expect(renderSms({ ...base, siteHost: "localhost:3000", scheme: "http", kind: "booking_confirmed" })).toContain(
      "http://localhost:3000/booking/find",
    );
  });
  it("cuts a long hotel name", () => {
    const t = renderSms({
      ...base,
      booking: { ...booking, property_name: "The Extraordinarily Long Named Hotel And Suites" },
      kind: "arrival_reminder",
    });
    expect(t.startsWith("The Extraordinarily Long Na.: ")).toBe(true);
    expect(t.split(":")[0]!.length).toBeLessThanOrEqual(28);
  });
  it("gsmSafe folds accents and quotes, drops two-place characters and anything that is not plain text", () => {
    expect(gsmSafe("Café “Ọlá” – ₦5,000 [x]{y}~|^\\ 😀")).toBe('Cafe "Ola" - NGN 5,000 xy');
  });
  it("counts parts: one up to 160 characters, then 153 each", () => {
    expect(smsParts("a".repeat(160))).toBe(1);
    expect(smsParts("a".repeat(161))).toBe(2);
    expect(smsParts("a".repeat(306))).toBe(2);
    expect(smsParts("a".repeat(307))).toBe(3);
  });
});

describe("termii provider", () => {
  const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  it("posts the documented body: number without plus, transactional route, sender id", async () => {
    const f = ok({ code: "ok", message_id: "m-1", message: "Successfully Sent" });
    const p = new TermiiProvider("key", "Hotel", "https://api.ng.termii.com/", null, f as unknown as typeof fetch);
    const r = await p.send({ to: "+2348031110002", text: "hello", channel: "sms", idempotencyKey: "row-1" });
    expect(r).toEqual({ providerMessageId: "m-1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.ng.termii.com/api/sms/send");
    expect(JSON.parse(init.body as string)).toEqual({
      api_key: "key",
      to: "2348031110002",
      from: "Hotel",
      sms: "hello",
      type: "plain",
      channel: "dnd",
    });
  });
  it("whatsapp uses the whatsapp channel and its own sender when set", async () => {
    const f = ok({ code: "ok", message_id: "m-2" });
    const p = new TermiiProvider("key", "Hotel", undefined, "HotelWA", f as unknown as typeof fetch);
    await p.send({ to: "+2348031110002", text: "hi", channel: "whatsapp", idempotencyKey: "row-2" });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.channel).toBe("whatsapp");
    expect(body.from).toBe("HotelWA");
  });
  it("a refusal about the number is permanent; one about the key, balance or sender is not; a server error is not", async () => {
    const send = (status: number, message: string) =>
      new TermiiProvider("k", "H", undefined, null, ok({ message }, status) as unknown as typeof fetch).send({
        to: "+2348031110002",
        text: "x",
        channel: "sms",
        idempotencyKey: "i",
      });
    await expect(send(400, "Invalid phone number")).rejects.toMatchObject({ permanent: true });
    await expect(send(400, "Insufficient balance")).rejects.toMatchObject({ permanent: false });
    await expect(send(401, "Invalid API key")).rejects.toMatchObject({ permanent: false });
    await expect(send(500, "Server error")).rejects.toMatchObject({ permanent: false });
    await expect(send(429, "Too many requests")).rejects.toThrow("Termii HTTP 429");
  });
  it("a 200 with an error code in the body is a failure; a network error is not permanent", async () => {
    const p = new TermiiProvider(
      "k",
      "H",
      undefined,
      null,
      ok({ code: "error", message: "Sender not registered" }) as unknown as typeof fetch,
    );
    await expect(p.send({ to: "+2348031110002", text: "x", channel: "sms", idempotencyKey: "i" })).rejects.toThrow("Sender not registered");
    const down = new TermiiProvider("k", "H", undefined, null, (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    await expect(down.send({ to: "+2348031110002", text: "x", channel: "sms", idempotencyKey: "i" })).rejects.toMatchObject({
      permanent: false,
    });
  });
  it("never puts the api key in an error message", async () => {
    const p = new TermiiProvider("super-secret-key", "H", undefined, null, ok({ message: "bad" }, 500) as unknown as typeof fetch);
    await expect(p.send({ to: "+2348031110002", text: "x", channel: "sms", idempotencyKey: "i" })).rejects.not.toThrow(/super-secret-key/);
  });
  it("isPermanentRefusal only looks at 400 and 422", () => {
    expect(isPermanentRefusal(400, "invalid number")).toBe(true);
    expect(isPermanentRefusal(422, "phone not valid")).toBe(true);
    expect(isPermanentRefusal(500, "invalid number")).toBe(false);
    expect(isPermanentRefusal(400, "")).toBe(false);
  });
});

describe("createSmsProvider", () => {
  it("is null without both the key and the sender id, the log transport when asked, Termii when configured", () => {
    expect(createSmsProvider({})).toBeNull();
    expect(createSmsProvider({ TERMII_API_KEY: "k" })).toBeNull();
    expect(createSmsProvider({ TERMII_SENDER_ID: "H" })).toBeNull();
    expect(createSmsProvider({ SMS_TRANSPORT: "log" })).toBeInstanceOf(LogSmsProvider);
    expect(createSmsProvider({ TERMII_API_KEY: "k", TERMII_SENDER_ID: "H" })).toBeInstanceOf(TermiiProvider);
  });
  it("the log transport prints neither the number nor the text", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await new LogSmsProvider().send({ to: "+2348031110002", text: "secret words", channel: "sms", idempotencyKey: "i" });
    const line = String(spy.mock.calls[0]?.[0]);
    spy.mockRestore();
    expect(line).not.toContain("8031110002");
    expect(line).not.toContain("secret words");
  });
});

const row = (over: Partial<ClaimedSms> = {}): ClaimedSms => ({
  id: "row-1",
  kind: "booking_confirmed",
  channel: "sms",
  to_phone: "+2348031110002",
  payload: {},
  attempt: 1,
  hotel_phone: null,
  site_host: "book.hotel-a.test",
  booking,
  ...over,
});

describe("drainSms", () => {
  const deps = (rows: ClaimedSms[], provider: SmsProvider) => {
    const mark = vi.fn(async () => {});
    return { mark, d: { claim: async () => rows, mark, provider, linkScheme: "https" as const, log: vi.fn() } };
  };
  it("sends each claimed text and records the provider id", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "m-9" }));
    const { d, mark } = deps([row()], { send });
    expect(await drainSms(d, 10)).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "+2348031110002", channel: "sms", idempotencyKey: "row-1" }));
    expect(mark).toHaveBeenCalledWith("row-1", { ok: true, error: undefined, providerId: "m-9", permanent: false });
  });
  it("one failure never stops the others, and a permanent refusal is passed on", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SmsSendError("Termii HTTP 400: Invalid phone number", true))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ providerMessageId: null });
    const { d, mark } = deps([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })], { send });
    expect(await drainSms(d, 10)).toEqual({ claimed: 3, sent: 1, failed: 2 });
    expect(mark).toHaveBeenNthCalledWith(1, "a", expect.objectContaining({ ok: false, permanent: true }));
    expect(mark).toHaveBeenNthCalledWith(2, "b", expect.objectContaining({ ok: false, permanent: false, error: "socket hang up" }));
    expect(mark).toHaveBeenNthCalledWith(3, "c", expect.objectContaining({ ok: true }));
  });
  it("a failure to record the result is logged and does not stop the run", async () => {
    const send = vi.fn(async () => ({ providerMessageId: null }));
    const log = vi.fn();
    const mark = vi.fn(async () => {
      throw new Error("db down");
    });
    const r = await drainSms(
      { claim: async () => [row({ id: "a" }), row({ id: "b" })], mark, provider: { send }, linkScheme: "https", log },
      10,
    );
    expect(r.sent).toBe(2);
    expect(log).toHaveBeenCalledWith("error", "could not record text result", expect.objectContaining({ smsId: "a" }));
  });
  it("sends nothing when nothing is claimed", async () => {
    const send = vi.fn();
    expect(await drainSms(deps([], { send }).d, 10)).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
