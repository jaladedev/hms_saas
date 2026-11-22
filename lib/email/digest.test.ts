import { describe, expect, it, vi } from "vitest";
import { digestPayload, drainDigests, occupancyText, renderDigest } from "./digest";

const payload = {
  hotel: "Hotel A <Ibadan>",
  date: "2026-11-14",
  arrivals: 3,
  departures: 2,
  in_house: 7,
  tomorrow: 4,
  holds: 1,
  messages: 2,
  waiting: 3,
};

describe("renderDigest", () => {
  it("lists the counts, escapes the hotel name and carries no guest details", () => {
    const e = renderDigest(payload);
    expect(e.subject).toBe("Hotel A <Ibadan>: 3 arriving, 2 leaving today");
    expect(e.text).toContain("Guests in house: 7");
    expect(e.text).toContain("Holds waiting for payment: 1");
    expect(e.text).toContain("Guest messages to answer: 2");
    expect(e.text).toContain("Waiting-list requests: 3");
    expect(e.html).toContain("Hotel A &lt;Ibadan&gt;");
    expect(e.html).not.toContain("<Ibadan>");
  });
  it("treats bad numbers as 0", () => {
    expect(digestPayload({ arrivals: -1, departures: "x", in_house: 2.9 })).toMatchObject({
      arrivals: 0,
      departures: 0,
      in_house: 2,
      hotel: "Your hotel",
      messages: 0,
      waiting: 0,
    });
  });
});

describe("occupancy", () => {
  it("writes occupancy as a share of the rooms in service", () => {
    expect(occupancyText(12, 20)).toBe("12 of 20 (60%)");
    expect(occupancyText(0, 20)).toBe("0 of 20 (0%)");
    expect(occupancyText(25, 20)).toBe("20 of 20 (100%)");
    expect(occupancyText(3, 0)).toBe("3");
  });
  it("puts it in the summary, and an old payload without it still renders", () => {
    const r = renderDigest({ hotel: "H", date: "2026-11-23", rooms: 20, occupied_tonight: 12, occupied_tomorrow: 15 });
    expect(r.text).toContain("Rooms occupied tonight: 12 of 20 (60%)");
    expect(r.text).toContain("Rooms booked for tomorrow night: 15 of 20 (75%)");
    expect(renderDigest({ hotel: "H" }).text).toContain("Rooms occupied tonight: 0");
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
