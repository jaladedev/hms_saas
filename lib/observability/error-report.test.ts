import { describe, expect, it } from "vitest";
import { buildEnvelope, buildEvent, dedupeKey, makeDeduper, newEventId, parseDsn, parseStack, scrubPath, scrubText } from "./error-report";

describe("parseDsn", () => {
  it("reads a Sentry-style DSN", () => {
    const d = parseDsn("https://abc123@o1.ingest.example.io/4501");
    expect(d).toMatchObject({ publicKey: "abc123", host: "o1.ingest.example.io", projectId: "4501", protocol: "https" });
    expect(d?.envelopeUrl).toBe("https://o1.ingest.example.io/api/4501/envelope/");
  });
  it("keeps a path prefix (self-hosted trackers)", () => {
    expect(parseDsn("https://k@track.example.com/errors/7")?.envelopeUrl).toBe("https://track.example.com/errors/api/7/envelope/");
  });
  it("turns reporting off for blanks and bad values", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "not a url",
      "ftp://k@h/1",
      "https://h/1",
      "https://k@h/",
      "https://k@h/abc",
      "https://@h/1",
    ]) {
      expect(parseDsn(bad as string)).toBeNull();
    }
  });
});

describe("scrubText", () => {
  it("replaces emails, uuids and long digit runs", () => {
    const s = scrubText(
      "duplicate key for ada@example.com id 11111111-2222-4333-8444-555555555555 card 4111 1111 1111 1111 phone +234 803 123 4567",
    );
    expect(s).not.toMatch(/ada@|4111|803|11111111-2222/);
    expect(s).toContain("[email]");
    expect(s).toContain("[id]");
    expect(s).toContain("[number]");
  });
  it("leaves short numbers and ordinary words alone, and truncates", () => {
    expect(scrubText("room 204 failed after 3 tries")).toBe("room 204 failed after 3 tries");
    expect(scrubText("x".repeat(5000)).length).toBe(1000);
  });
});

describe("scrubPath", () => {
  it("drops the query and hash and masks ids", () => {
    expect(scrubPath("/app/guests/11111111-2222-4333-8444-555555555555?tab=1#x")).toBe("/app/guests/:id");
    expect(scrubPath("/app/reservations/123456/documents")).toBe("/app/reservations/:id/documents");
    expect(scrubPath("/app/guests/[id]")).toBe("/app/guests/[id]");
    expect(scrubPath(undefined)).toBe("");
  });
});

describe("parseStack", () => {
  it("parses V8 frames, oldest first, and skips other lines", () => {
    const stack = ["Error: boom", "    at inner (/srv/app/a.js?x=1:10:5)", "    at /srv/app/b.js:20:7", "garbage"].join("\n");
    const f = parseStack(stack);
    expect(f).toEqual([
      { function: undefined, filename: "/srv/app/b.js", lineno: 20, colno: 7 },
      { function: "inner", filename: "/srv/app/a.js", lineno: 10, colno: 5 },
    ]);
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("buildEvent", () => {
  it("builds an event with a scrubbed message, the route pattern and tags, and nothing personal", () => {
    const err = new Error("could not find ada@example.com");
    const ev = buildEvent(
      err,
      {
        routePath: "/app/guests/[id]",
        path: "/app/guests/11111111-2222-4333-8444-555555555555?secret=1",
        method: "POST",
        routeType: "action",
        digest: "d1",
        release: "r1",
        environment: "staging",
      },
      () => 1_700_000_000_000,
      () => "a".repeat(32),
    );
    expect(ev.timestamp).toBe(1_700_000_000);
    expect(ev.exception.values[0]?.value).toBe("could not find [email]");
    expect(ev.tags).toMatchObject({ route: "/app/guests/[id]", route_type: "action", digest: "d1" });
    expect(ev.request).toEqual({ method: "POST", url: "/app/guests/[id]" });
    expect(ev.release).toBe("r1");
    expect(JSON.stringify(ev)).not.toMatch(/secret=1|ada@|11111111-2222/);
  });
  it("copes with a thrown string, a thrown object and no context", () => {
    expect(buildEvent("boom").exception.values[0]?.value).toBe("boom");
    expect(buildEvent({ a: 1 }).exception.values[0]?.value).toBe("Non-error thrown");
    expect(buildEvent(new Error("x")).request).toBeUndefined();
  });
});

describe("buildEnvelope and ids", () => {
  it("writes header, item header and event on three lines", () => {
    const dsn = parseDsn("https://key@host.example/9")!;
    const ev = buildEvent(
      new Error("e"),
      {},
      () => 0,
      () => "b".repeat(32),
    );
    const lines = buildEnvelope(ev, dsn, new Date("2026-11-23T10:00:00Z")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({
      event_id: "b".repeat(32),
      sent_at: "2026-11-23T10:00:00.000Z",
      dsn: "https://key@host.example/9",
    });
    expect(JSON.parse(lines[1]!)).toEqual({ type: "event" });
    expect(JSON.parse(lines[2]!).event_id).toBe("b".repeat(32));
  });
  it("makes 32 hex characters", () => {
    expect(newEventId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("makeDeduper", () => {
  it("lets an error through once per window", () => {
    let t = 0;
    const once = makeDeduper(1000, 5, () => t);
    expect(once("a")).toBe(true);
    expect(once("a")).toBe(false);
    expect(once("b")).toBe(true);
    t = 1500;
    expect(once("a")).toBe(true);
  });
  it("never grows past its limit", () => {
    const once = makeDeduper(60_000, 3, () => 0);
    for (const k of ["a", "b", "c", "d"]) once(k);
    expect(once("a")).toBe(true); // the oldest was dropped to make room
  });
  it("keys on type, message, route and line", () => {
    const a = buildEvent(new Error("same"), { routePath: "/x" });
    const b = buildEvent(new Error("same"), { routePath: "/y" });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b));
  });
});
