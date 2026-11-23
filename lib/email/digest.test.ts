import { describe, expect, it, vi } from "vitest";
import {
  digestPayload,
  drainDigests,
  occupancyPercent,
  occupancyText,
  outlookLines,
  outlookSummary,
  renderDigest,
  shortDay,
} from "./digest";

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

const week = [
  { date: "2026-11-14", occupied: 12 },
  { date: "2026-11-15", occupied: 18 },
  { date: "2026-11-16", occupied: 5 },
  { date: "2026-11-17", occupied: 10 },
  { date: "2026-11-18", occupied: 10 },
  { date: "2026-11-19", occupied: 20 },
  { date: "2026-11-20", occupied: 15 },
];

describe("the week ahead", () => {
  it("names the weekday without any locale data", () => {
    expect(shortDay("2026-11-14")).toBe("Sat 14 Nov");
    expect(shortDay("2027-01-01")).toBe("Fri 1 Jan");
    expect(shortDay("2028-02-29")).toBe("Tue 29 Feb");
    expect(shortDay("garbage")).toBe("garbage");
  });
  it("percent: whole numbers, never above 100, null with no rooms in service", () => {
    expect(occupancyPercent(12, 20)).toBe(60);
    expect(occupancyPercent(1, 3)).toBe(33);
    expect(occupancyPercent(2, 3)).toBe(67);
    expect(occupancyPercent(25, 20)).toBe(100);
    expect(occupancyPercent(0, 20)).toBe(0);
    expect(occupancyPercent(5, 0)).toBeNull();
  });
  it("reads the nights the database stored and ignores anything malformed", () => {
    expect(digestPayload({ outlook: week }).outlook).toHaveLength(7);
    expect(digestPayload({}).outlook).toEqual([]);
    expect(digestPayload({ outlook: "x" }).outlook).toEqual([]);
    expect(
      digestPayload({ outlook: [null, 5, { date: "2026-11-14" }, { date: "14/11", occupied: 1 }, { date: "2026-11-14", occupied: -1 }] })
        .outlook,
    ).toEqual([]);
    expect(digestPayload({ outlook: [{ date: "2026-11-14", occupied: 3.9 }] }).outlook).toEqual([{ date: "2026-11-14", occupied: 3 }]);
    expect(digestPayload({ outlook: [...week, ...week] }).outlook).toHaveLength(7);
  });
  it("summarises the whole week, the busiest and the quietest night", () => {
    expect(outlookSummary(week, 20)).toEqual({
      nights: 7,
      percent: 64,
      busiest: { date: "2026-11-19", percent: 100 },
      quietest: { date: "2026-11-16", percent: 25 },
    });
    expect(outlookSummary([], 20)).toBeNull();
    expect(outlookSummary([week[0]!], 20)).toBeNull();
    expect(outlookSummary(week, 0)).toBeNull();
    // every night the same: nothing to point at
    expect(
      outlookSummary(
        [
          { date: "2026-11-14", occupied: 5 },
          { date: "2026-11-15", occupied: 5 },
        ],
        10,
      ),
    ).toMatchObject({ busiest: null, quietest: null });
    // the week figure divides totals, it does not average the daily percentages
    expect(
      outlookSummary(
        [
          { date: "2026-11-14", occupied: 1 },
          { date: "2026-11-15", occupied: 9 },
        ],
        100,
      )?.percent,
    ).toBe(5);
    // a night above the rooms in service counts as full, not more
    expect(
      outlookSummary(
        [
          { date: "2026-11-14", occupied: 30 },
          { date: "2026-11-15", occupied: 10 },
        ],
        20,
      )?.percent,
    ).toBe(75);
  });
  it("writes the sentences", () => {
    expect(outlookLines(week, 20)).toEqual([
      "Next 7 nights: 64% occupied",
      "Busiest night: Thu 19 Nov (100%)",
      "Quietest night: Mon 16 Nov (25%)",
    ]);
    expect(outlookLines([], 20)).toEqual([]);
  });
  it("puts the week and the percentage in the email, and keeps the older email when there is none", () => {
    const base = { ...payload, rooms: 20, occupied_tonight: 12, occupied_tomorrow: 18 };
    const e = renderDigest({ ...base, outlook: week });
    expect(e.subject).toBe("Hotel A <Ibadan>: 60% full tonight, 3 arriving, 2 leaving");
    expect(e.text).toContain("Rooms occupied tonight: 12 of 20 (60%)");
    expect(e.text).toContain("Next 7 nights: 64% occupied");
    expect(e.text).toContain("Busiest night: Thu 19 Nov (100%)");
    expect(e.text).toContain("Rooms occupied by night:");
    expect(e.text).toContain("Sat 14 Nov: 12 of 20 (60%)");
    expect(e.html).toContain("Rooms occupied by night");
    expect(e.html).toContain("Next 7 nights: 64% occupied");
    expect(e.html).toContain("Hotel A &lt;Ibadan&gt;");
    expect(e.html).not.toContain("<Ibadan>");
    expect(e.text).not.toMatch(/@|₦|NGN/);
    // queued after migration 180 but before 184: the percentage in the subject, no week
    const mid = renderDigest(base);
    expect(mid.subject).toBe("Hotel A <Ibadan>: 60% full tonight, 3 arriving, 2 leaving");
    expect(mid.text).not.toContain("Next 7 nights");
    expect(mid.text).not.toContain("Rooms occupied by night");
    // no rooms in service, or an old summary: the plain subject
    expect(renderDigest(payload).subject).toBe("Hotel A <Ibadan>: 3 arriving, 2 leaving today");
    expect(renderDigest({ ...payload, outlook: week }).text).not.toContain("Next 7 nights");
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
