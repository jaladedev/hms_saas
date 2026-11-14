import { describe, expect, it, vi } from "vitest";
import { drainNotices, renderWaitlistNotice, searchLink, noticePayload } from "./waitlist-notice";

const payload = {
  hotel: "Hotel A <Ibadan>",
  room_type: "Solo Suite",
  guest_name: "Ada <script>",
  arrival: "2027-03-01",
  departure: "2027-03-03",
  adults: 2,
  children: 1,
  site_host: "book.hotel-a.test",
};

describe("renderWaitlistNotice", () => {
  it("says a room may be free, promises nothing and links to the same search", () => {
    const e = renderWaitlistNotice(payload);
    expect(e.subject).toBe("A room may now be free at Hotel A <Ibadan>");
    expect(e.text).toContain("Nothing is held");
    expect(e.text).toContain("https://book.hotel-a.test/?arrival=2027-03-01&departure=2027-03-03&adults=2&children=1");
    expect(e.html).toContain("Hotel A &lt;Ibadan&gt;");
    expect(e.html).toContain("Ada &lt;script&gt;");
    expect(e.html).not.toContain("<script>");
  });
  it("uses http when asked (local development)", () => {
    expect(renderWaitlistNotice(payload, "http").text).toContain("http://book.hotel-a.test/?");
  });
  it("refuses to send without usable dates or a plain host name", () => {
    expect(() => renderWaitlistNotice({ ...payload, arrival: "soon" })).toThrow(/usable/);
    expect(() => renderWaitlistNotice({ ...payload, site_host: "evil.test/path?x=" })).toThrow(/usable/);
    expect(searchLink(noticePayload({ ...payload, site_host: "localhost:3000" }), "http")).toContain("localhost:3000");
  });
});

describe("drainNotices", () => {
  it("sends each, records failures and keeps going", async () => {
    const send = vi.fn(async (m: { to: string }) => {
      if (m.to === "bad@x.co") throw new Error("mail down");
    });
    const mark = vi.fn(async () => {});
    const out = await drainNotices(
      {
        claim: async () => [
          { id: "1", to_email: "bad@x.co", payload, attempt: 1 },
          { id: "2", to_email: "ok@x.co", payload, attempt: 1 },
          { id: "3", to_email: "odd@x.co", payload: { ...payload, arrival: "x" }, attempt: 1 },
        ],
        mark,
        mailer: { send },
        linkScheme: "https",
      },
      10,
    );
    expect(out).toEqual({ claimed: 3, sent: 1, failed: 2 });
    expect(mark).toHaveBeenCalledWith("2", true, undefined);
    expect(mark).toHaveBeenCalledWith("1", false, "mail down");
  });
});
