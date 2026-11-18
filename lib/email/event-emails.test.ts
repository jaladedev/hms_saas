import { describe, expect, it } from "vitest";
import { drainEventEmails, renderEventEmail, type ClaimedEventEmail } from "./event-emails";

const LINK = "https://hotel.test/event-booking/tok";
const booking = {
  reference: "EVB-1",
  status: "tentative",
  venue: "Grand Hall",
  hotel: "Hotel A",
  event_type: "wedding",
  title: "",
  starts_at: "2027-03-01T10:00:00",
  ends_at: "2027-03-01T16:00:00",
  attendees: 50,
  contact_name: "Zed <b>",
  currency: "NGN",
  subtotal_minor: 30000000,
  service_minor: 0,
  tax_minor: 0,
  total_minor: 35475000,
  deposit_minor: 10642500,
  paid_minor: 0,
  due_minor: 10642500,
  hold_expires_at: "2027-01-01T10:00:00",
  lines: [],
};
const order = {
  reference: "TKT-1",
  status: "paid",
  hotel: "Hotel A",
  event: "Jazz night",
  event_status: "on_sale",
  starts_at: "2027-03-01T19:00:00",
  ends_at: "2027-03-01T23:00:00",
  venue: "Grand Hall",
  buyer_name: "Rex",
  currency: "NGN",
  total_minor: 1000000,
  paid_minor: 1000000,
  due_minor: 0,
  hold_expires_at: null,
  items: [],
  tickets: [{ code: "TABC123456", status: "valid", type: "Regular" }],
};

describe("renderEventEmail", () => {
  it("says what is held and what to pay, and escapes names in the html", () => {
    const e = renderEventEmail("venue_held", booking, LINK);
    expect(e.subject).toContain("held");
    expect(e.text).toContain(LINK);
    expect(e.text).toMatch(/deposit of .*106,425/);
    expect(e.html).toContain("Zed &lt;b&gt;");
    expect(e.html).not.toContain("<b>");
  });
  it("words an enquiry, a confirmation and tickets", () => {
    expect(renderEventEmail("venue_received", booking, LINK).text).toContain("Nothing is held yet");
    expect(renderEventEmail("venue_confirmed", { ...booking, due_minor: 0 }, LINK).text).toContain("Nothing more is due");
    const t = renderEventEmail("tickets_paid", order, "https://hotel.test/tickets/tok");
    expect(t.text).toContain("TABC123456");
    expect(t.subject).toContain("Jazz night");
  });
  it("refuses unusable data", () => {
    expect(() => renderEventEmail("venue_held", null, LINK)).toThrow();
    expect(() => renderEventEmail("tickets_paid", { nope: 1 }, LINK)).toThrow();
    expect(() => renderEventEmail("venue_held", { nope: 1 }, LINK)).toThrow();
  });
});

describe("drainEventEmails", () => {
  const row = (over: Partial<ClaimedEventEmail>): ClaimedEventEmail => ({
    id: "e1",
    kind: "venue_held",
    to_email: "z@example.com",
    attempt: 1,
    target_id: "11111111-2222-4333-8444-555555555555",
    site_host: "hotel.test",
    view: booking,
    ...over,
  });
  async function run(rows: ClaimedEventEmail[]) {
    const sent: { to: string; text: string }[] = [];
    const marks: [string, boolean][] = [];
    const tokens: string[] = [];
    const result = await drainEventEmails(
      {
        claim: async () => rows,
        mark: async (id, ok) => void marks.push([id, ok]),
        mailer: { send: async (m) => void sent.push({ to: m.to, text: m.text }) },
        makeToken: (kind, id) => (tokens.push(kind + id), "tok"),
        linkScheme: "https",
      },
      10,
    );
    return { result, sent, marks, tokens };
  }
  it("links a booking to /event-booking and tickets to /tickets, with the right kind of token", async () => {
    const { sent, tokens, result } = await run([row({}), row({ id: "e2", kind: "tickets_paid", view: order })]);
    expect(result).toEqual({ claimed: 2, sent: 2, failed: 0 });
    expect(sent[0]!.text).toContain("https://hotel.test/event-booking/tok");
    expect(sent[1]!.text).toContain("https://hotel.test/tickets/tok");
    expect(tokens.map((t) => t[0])).toEqual(["v", "t"]);
  });
  it("fails a row with no usable host or data without stopping the others", async () => {
    const { result, marks, sent } = await run([
      row({ id: "a", site_host: null }),
      row({ id: "b", site_host: "bad host/" }),
      row({ id: "c", view: null }),
      row({ id: "d" }),
    ]);
    expect(result).toEqual({ claimed: 4, sent: 1, failed: 3 });
    expect(marks).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", true],
    ]);
    expect(sent).toHaveLength(1);
  });
});
