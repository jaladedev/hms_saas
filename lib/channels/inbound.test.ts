import { describe, expect, it } from "vitest";
import {
  classifyChannelError,
  failureWords,
  parseBookings,
  parseChannelReport,
  parseConnectionForm,
  parseResolveForm,
} from "@/lib/staff/channel-sync";
import { channelBearerKey, inboundErrorStatus, MAX_BODY_BYTES, parseFeedQuery, parseInbound } from "./inbound";

const KEY = "chn_0123abcd_" + "a".repeat(48);
const P = "00000000-0000-0000-0000-0000000000a2";

describe("inbound key", () => {
  it("accepts only our shape from a Bearer header", () => {
    expect(channelBearerKey(`Bearer ${KEY}`)).toBe(KEY);
    expect(channelBearerKey(`bearer ${KEY}`)).toBe(KEY);
    expect(channelBearerKey(KEY)).toBeNull();
    expect(channelBearerKey("Bearer hms_0123abcd_" + "a".repeat(48))).toBeNull();
    expect(channelBearerKey("Bearer chn_short")).toBeNull();
    expect(channelBearerKey(null)).toBeNull();
  });
});

describe("inbound body", () => {
  it("reads event, booking id and the rest", () => {
    const r = parseInbound(JSON.stringify({ event: "booking", booking_id: " B-1 ", arrival: "2026-12-01", rooms: [] }));
    expect(r).toEqual({ ok: true, event: "booking", bookingId: "B-1", payload: { arrival: "2026-12-01", rooms: [] } });
  });
  it("refuses bad shapes", () => {
    expect(parseInbound("").ok).toBe(false);
    expect(parseInbound("not json").ok).toBe(false);
    expect(parseInbound("[]").ok).toBe(false);
    expect(parseInbound(JSON.stringify({ event: "refund", booking_id: "x" })).ok).toBe(false);
    expect(parseInbound(JSON.stringify({ event: "cancel", booking_id: "" })).ok).toBe(false);
    expect(parseInbound(JSON.stringify({ event: "cancel", booking_id: "x".repeat(81) })).ok).toBe(false);
    expect(parseInbound("x".repeat(MAX_BODY_BYTES + 1)).ok).toBe(false);
  });
  it("maps database refusals to answers without database text", () => {
    expect(inboundErrorStatus("NOT_FOUND")).toEqual({ status: 401, error: "unauthorized" });
    expect(inboundErrorStatus("POLICY_VIOLATION: payload")).toEqual({ status: 400, error: "invalid_request" });
    expect(inboundErrorStatus("duplicate key value violates")).toEqual({ status: 500, error: "server_error" });
  });
});

describe("screens", () => {
  it("classifies errors and words failures", () => {
    expect(classifyChannelError("NOT_FOUND")).toBe("ch_forbidden");
    expect(classifyChannelError("POLICY_VIOLATION: channels off")).toBe("ch_off");
    expect(classifyChannelError("POLICY_VIOLATION: too many")).toBe("ch_too_many");
    expect(classifyChannelError("POLICY_VIOLATION: room type")).toBe("ch_room_type");
    expect(classifyChannelError("INVALID_STATE: revoked")).toBe("ch_state");
    expect(classifyChannelError("POLICY_VIOLATION: label")).toBe("ch_invalid");
    expect(failureWords("POLICY_VIOLATION: unmapped room")).toMatch(/not mapped/);
    expect(failureWords("ROOM_UNAVAILABLE")).toMatch(/No room/);
    expect(failureWords("database 23P01")).toMatch(/same moment/);
    expect(failureWords(null)).toBe("");
  });
  it("checks forms", () => {
    expect(parseConnectionForm({ propertyId: P, channel: "expedia", label: "Main", collects: "channel" }).ok).toBe(true);
    expect(parseConnectionForm({ propertyId: P, channel: "agoda", label: "Main", collects: "channel" }).ok).toBe(false);
    expect(parseConnectionForm({ propertyId: P, channel: "expedia", label: "", collects: "channel" }).ok).toBe(false);
    expect(parseResolveForm({ bookingId: P, note: "ok" }).ok).toBe(false);
    expect(parseResolveForm({ bookingId: P, note: "Moved by hand" }).ok).toBe(true);
  });
  it("reads rows and the report", () => {
    const b = parseBookings([
      { id: "1", connection_id: "c", external_id: "E", status: "weird", channel_total_minor: "500", attempts: 2, created_at: "t" },
    ]);
    expect(b[0]?.status).toBe("received");
    expect(b[0]?.channelTotalMinor).toBe(500);
    const r = parseChannelReport({
      counts: { imported: 2, bogus: 9 },
      price_differences: [{ id: "p", external_id: "E", reference: "R", channel_total_minor: 1, our_total_minor: 2 }],
      cancelled_here: [],
    });
    expect(r?.counts).toEqual({ imported: 2 });
    expect(r?.priceDifferences[0]?.currency).toBe("NGN");
    expect(parseChannelReport(null)).toBeNull();
  });
});

describe("feed query", () => {
  const q = (s: string) => parseFeedQuery(new URLSearchParams(s));
  it("accepts real dates up to 90 nights", () => {
    expect(q("from=2026-12-01&to=2026-12-15")).toEqual({ ok: true, from: "2026-12-01", to: "2026-12-15" });
    expect(q("from=2026-12-01&to=2027-03-01").ok).toBe(true);
  });
  it("refuses anything else", () => {
    for (const s of [
      "",
      "from=2026-12-01",
      "from=2026-12-01&to=2026-12-01",
      "from=2026-12-05&to=2026-12-01",
      "from=2026-12-01&to=2027-03-02",
      "from=2026-02-30&to=2026-03-05",
      "from=x&to=y",
      "from=2026-12-01&to=2026-12-0",
    ])
      expect(q(s).ok).toBe(false);
  });
});

describe("channel payment report", () => {
  it("reads the bookings that still owe money", () => {
    const r = parseChannelReport({
      counts: {},
      price_differences: [],
      cancelled_here: [],
      awaiting_payment: [{ id: "b1", external_id: "X-1", reference: "BK-1", owed_minor: 2500000, currency: "NGN" }, "junk"],
    });
    expect(r?.awaitingPayment).toEqual([{ id: "b1", externalId: "X-1", reference: "BK-1", owedMinor: 2500000, currency: "NGN" }]);
    expect(parseChannelReport({ counts: {} })?.awaitingPayment).toEqual([]);
  });
});
