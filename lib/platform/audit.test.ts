import { describe, expect, it } from "vitest";
import { auditTime, describeAction, describeFields, filterQuery, nextPageQuery, parseAuditFilter, readAuditPage } from "./audit";

const ID = "00000000-0000-0000-0000-0000000000a2";

describe("parseAuditFilter", () => {
  it("keeps good values", () => {
    expect(
      parseAuditFilter({
        hotel: ID,
        q: "  ticket  ",
        from: "2026-11-01",
        to: "2026-11-14",
        beforeAt: "2026-11-14T10:00:00Z",
        beforeId: ID,
      }),
    ).toEqual({
      hotel: ID,
      search: "ticket",
      from: "2026-11-01",
      to: "2026-11-14",
      beforeAt: "2026-11-14T10:00:00Z",
      beforeId: ID,
    });
  });
  it("drops anything that is not a plain id, date or short text", () => {
    const f = parseAuditFilter({
      hotel: "x'; drop",
      q: "a".repeat(200),
      from: "2026-02-31",
      to: "tomorrow",
      beforeAt: "soon",
      beforeId: ID,
    });
    expect(f.hotel).toBe("");
    expect(f.search).toHaveLength(60);
    expect(f.from).toBe("");
    expect(f.to).toBe("");
    expect(f.beforeAt).toBe("");
    expect(f.beforeId).toBe("");
  });
  it("needs both halves of the page cursor", () => {
    expect(parseAuditFilter({ beforeAt: "2026-11-14T10:00:00Z" }).beforeAt).toBe("");
    expect(parseAuditFilter({ beforeId: ID }).beforeId).toBe("");
  });
  it("ignores values that are not text", () => {
    expect(parseAuditFilter({ hotel: 5, q: ["a"], from: null })).toEqual({
      hotel: "",
      search: "",
      from: "",
      to: "",
      beforeAt: "",
      beforeId: "",
    });
  });
});

describe("wording", () => {
  it("names known actions, platform entity verbs, and shows unknown ones as written", () => {
    expect(describeAction("platform.tenant_created")).toBe("Hotel group created");
    expect(describeAction("platform_ticket.updated")).toBe("Support ticket updated");
    expect(describeAction("platform_access.created")).toBe("Access request created");
    expect(describeAction("platform_ticket_note.created")).toBe("Ticket note created");
    expect(describeAction("something.odd")).toBe("something.odd");
  });
  it("lists changed fields", () => {
    expect(describeFields(["status", "resolved_at"])).toBe("status, resolved at");
    expect(describeFields([])).toBe("");
  });
  it("shows UTC times", () => {
    expect(auditTime("2026-11-14T15:48:09+01:00")).toBe("2026-11-14 14:48 UTC");
    expect(auditTime("nope")).toBe("unknown");
  });
});

describe("readAuditPage and paging", () => {
  it("reads rows, skips malformed ones, defaults the rest", () => {
    const page = readAuditPage({
      events: [
        { id: ID, at: "2026-11-14T10:00:00Z", action: "platform.tenant_created", fields: ["a", 3, "b"] },
        { id: 5 },
        null,
        { at: "x" },
      ],
      has_more: true,
    });
    expect(page.has_more).toBe(true);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ id: ID, actor: null, tenant_name: null, fields: ["a", "b"] });
  });
  it("survives nothing at all", () => {
    expect(readAuditPage(null)).toEqual({ events: [], has_more: false });
    expect(readAuditPage({ events: "x", has_more: "yes" })).toEqual({ events: [], has_more: false });
  });
  it("builds the next page's query with the filters kept", () => {
    const q = new URLSearchParams(nextPageQuery(parseAuditFilter({ hotel: ID, q: "ticket" }), { at: "2026-11-14T10:00:00Z", id: ID }));
    expect(q.get("hotel")).toBe(ID);
    expect(q.get("q")).toBe("ticket");
    expect(q.get("beforeAt")).toBe("2026-11-14T10:00:00Z");
    expect(q.get("beforeId")).toBe(ID);
    expect(q.has("from")).toBe(false);
  });
});

describe("filterQuery", () => {
  it("keeps the filters and never the cursor", () => {
    const f = parseAuditFilter({ hotel: ID, q: "ticket", beforeAt: "2026-11-14T10:00:00Z", beforeId: ID });
    const q = new URLSearchParams(filterQuery(f));
    expect(q.get("hotel")).toBe(ID);
    expect(q.has("beforeAt")).toBe(false);
    expect(filterQuery(parseAuditFilter({}))).toBe("");
  });
});
