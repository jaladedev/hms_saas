import { describe, expect, it, vi } from "vitest";
import { digestPayload, drainDigests, renderDigest } from "./digest";

const payload = { hotel: "Hotel A <Ibadan>", date: "2026-11-14", arrivals: 3, departures: 2, in_house: 7, tomorrow: 4, holds: 1 };

describe("renderDigest", () => {
  it("lists the counts, escapes the hotel name and carries no guest details", () => {
    const e = renderDigest(payload);
    expect(e.subject).toBe("Hotel A <Ibadan>: 3 arriving, 2 leaving today");
    expect(e.text).toContain("Guests in house: 7");
    expect(e.text).toContain("Holds waiting for payment: 1");
    expect(e.html).toContain("Hotel A &lt;Ibadan&gt;");
    expect(e.html).not.toContain("<Ibadan>");
  });
  it("treats bad numbers as 0", () => {
    expect(digestPayload({ arrivals: -1, departures: "x", in_house: 2.9 })).toMatchObject({
      arrivals: 0,
      departures: 0,
      in_house: 2,
      hotel: "Your hotel",
    });
  });
});

describe("drainDigests", () => {
  it("sends each, records failures and keeps going", async () => {
    const send = vi.fn(async (m: { to: string }) => {
      if (m.to === "bad@x.co") throw new Error("mail down");
    });
    const mark = vi.fn(async () => {});
    const out = await drainDigests(
      {
        claim: async () => [
          { id: "1", to_email: "bad@x.co", payload, attempt: 1 },
          { id: "2", to_email: "ok@x.co", payload, attempt: 1 },
        ],
        mark,
        mailer: { send },
      },
      10,
    );
    expect(out).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(mark).toHaveBeenCalledWith("1", false, "mail down");
    expect(mark).toHaveBeenCalledWith("2", true, undefined);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "2" }));
  });
});
