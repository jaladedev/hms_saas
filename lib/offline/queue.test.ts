import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  MAX_QUEUE,
  addItem,
  applyResults,
  buildItem,
  isFolioItem,
  isHousekeepingItem,
  isNoteItem,
  keepOnlyUser,
  keptOnly,
  madeAtOf,
  parseKept,
  parseStored,
  type FolioQueuedItem,
  type HousekeepingQueuedItem,
  type NoteQueuedItem,
} from "./queue";

const A = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const B = "7f3e2a10-1b4c-4d5e-8f60-a1b2c3d4e5f6";
const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "22222222-3333-4444-8555-666666666666";
const now = new Date("2026-11-23T10:42:00Z");

function item(over: Partial<HousekeepingQueuedItem> = {}): HousekeepingQueuedItem {
  return {
    id: crypto.randomUUID(),
    action: "start",
    taskId: T1,
    userId: A,
    label: "Room 204 · Start",
    queuedAt: now.toISOString(),
    attempts: 0,
    ...over,
  };
}

describe("building a waiting change from a form", () => {
  const base = {
    action: "complete",
    fields: { taskId: T1, note: "  Mini bar restocked  " },
    label: "Room 204 · Done",
    userId: A,
    id: B,
    now,
  };
  it("keeps the note only for a completion, trimmed and capped", () => {
    expect(buildItem(base)).toMatchObject({ action: "complete", taskId: T1, userId: A, note: "Mini bar restocked", attempts: 0 });
    expect(buildItem({ ...base, action: "start" })).not.toHaveProperty("note");
    expect((buildItem({ ...base, fields: { taskId: T1, note: "x".repeat(900) } }) as HousekeepingQueuedItem).note).toHaveLength(500);
  });
  it("refuses a form that is not allowed to wait or has no valid task", () => {
    expect(buildItem({ ...base, action: undefined })).toBeNull();
    expect(buildItem({ ...base, action: "cancel" })).toBeNull();
    expect(buildItem({ ...base, fields: { taskId: "nope" } })).toBeNull();
    expect(buildItem({ ...base, userId: "nope" })).toBeNull();
  });
});

describe("building a waiting repair change from a form", () => {
  // A repair form names its target requestId (a housekeeping form names taskId); the queue keeps it as the one target id.
  const base = {
    action: "maint_resolve",
    fields: { requestId: T1, note: "  Replaced the tap washer  " },
    label: "Room 204 · Fixed",
    userId: A,
    id: B,
    now,
  };
  it("reads the target from requestId and keeps the note only for a resolve, up to 1000 characters", () => {
    expect(buildItem(base)).toMatchObject({ action: "maint_resolve", taskId: T1, userId: A, note: "Replaced the tap washer", attempts: 0 });
    expect(buildItem({ ...base, action: "maint_start" })).not.toHaveProperty("note");
    expect(buildItem({ ...base, action: "maint_claim" })).not.toHaveProperty("note");
    expect((buildItem({ ...base, fields: { requestId: T1, note: "x".repeat(1500) } }) as HousekeepingQueuedItem).note).toHaveLength(1000);
  });
  it("refuses a repair form without a valid request id, and does not read a taskId from it", () => {
    expect(buildItem({ ...base, fields: { note: "x" } })).toBeNull();
    expect(buildItem({ ...base, fields: { requestId: "nope" } })).toBeNull();
    expect(buildItem({ ...base, fields: { taskId: T1 } })).toBeNull();
  });
  it("keeps a repair step apart from the same step on a housekeeping task with the same id", () => {
    const hk = buildItem({ ...base, action: "start", fields: { taskId: T1 } })!;
    const mt = buildItem({ ...base, action: "maint_start", id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" })!;
    const first = addItem([], hk);
    expect(addItem(first.queue, mt).added).toBe(true);
    expect(addItem(addItem([], mt).queue, mt).added).toBe(false);
  });
});

describe("the queue", () => {
  it("does not queue the same step on the same task twice, or grow without limit", () => {
    const first = addItem([], item());
    expect(first.added).toBe(true);
    expect(addItem(first.queue, item()).added).toBe(false);
    expect(addItem(first.queue, item({ action: "complete" })).added).toBe(true);
    expect(addItem(first.queue, item({ taskId: T2 })).added).toBe(true);
    const full = Array.from({ length: MAX_QUEUE }, (_, i) => item({ taskId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    expect(addItem(full, item({ taskId: T2 })).added).toBe(false);
  });

  it("applies the server's answers", () => {
    const a = item({ id: "a" }),
      b = item({ id: "b" }),
      c = item({ id: "c" }),
      d = item({ id: "d" }),
      e = item({ id: "e" });
    const out = applyResults(
      [a, b, c, d, e],
      [
        { id: "a", status: "done" },
        { id: "b", status: "already" },
        { id: "c", status: "rejected", reason: "taken" },
        { id: "d", status: "retry" },
      ],
    );
    expect(out.applied).toBe(1);
    expect(out.problems).toEqual([{ id: "c", label: "Room 204 · Start", reason: "taken" }]);
    expect(out.queue.map((q) => [q.id, q.attempts])).toEqual([
      ["d", 1],
      ["e", 0],
    ]);
  });

  it("gives up on a change that keeps failing, and says so", () => {
    const stuck = item({ id: "s", attempts: MAX_ATTEMPTS - 1 });
    const out = applyResults([stuck], [{ id: "s", status: "retry" }]);
    expect(out.queue).toEqual([]);
    expect(out.problems).toEqual([{ id: "s", label: "Room 204 · Start", reason: "error" }]);
  });

  it("drops what someone else saved on this computer", () => {
    expect(keepOnlyUser([item({ id: "mine", userId: A }), item({ id: "theirs", userId: B })], A).map((q) => q.id)).toEqual(["mine"]);
  });
});

describe("reading what was stored", () => {
  it("returns nothing for missing, broken or foreign data", () => {
    expect(parseStored(null)).toEqual([]);
    expect(parseStored("not json")).toEqual([]);
    expect(parseStored('{"a":1}')).toEqual([]);
  });
  it("keeps good entries and drops tampered ones", () => {
    const good = item({ id: A });
    const bad = { ...item({ id: B }), action: "cancel" };
    const worse = { ...item({ id: T2 }), taskId: "'; drop table" };
    expect(parseStored(JSON.stringify([good, bad, worse, 7, null]))).toEqual([good]);
  });
});

describe("the time a waiting change was made", () => {
  it("is the moment it was queued, as an ISO time with a zone", () => {
    const later = new Date("2026-11-23T11:20:00Z");
    expect(madeAtOf("2026-11-23T10:42:00.000Z", later)).toBe("2026-11-23T10:42:00.000Z");
    expect(madeAtOf("2026-11-23T11:42:00+01:00", later)).toBe("2026-11-23T10:42:00.000Z");
  });
  it("is never in the future, so a laptop clock that was ahead cannot send one", () => {
    expect(madeAtOf("2026-11-24T10:42:00.000Z", new Date("2026-11-23T11:20:00Z"))).toBe("2026-11-23T11:20:00.000Z");
  });
  it("is left out when the stored text is not a time", () => {
    expect(madeAtOf("", now)).toBeUndefined();
    expect(madeAtOf("soon", now)).toBeUndefined();
  });
  it("is the item's own queuedAt for an item built from a form", () => {
    const built = buildItem({ action: "start", fields: { taskId: T1 }, label: "Room 1", userId: A, id: B, now });
    expect(built && madeAtOf(built.queuedAt, new Date("2026-11-23T12:00:00Z"))).toBe(now.toISOString());
  });
});

const R1 = "33333333-4444-4555-8666-777777777777";
const K1 = "44444444-5555-4666-8777-888888888888";
const K2 = "55555555-6666-4777-8888-999999999999";
const chargeFields = {
  reservationId: R1,
  idempotencyKey: "page-key-1",
  category: "minibar",
  description: "  2 bottles of water ",
  quantity: "2",
  amount: "1,500",
  date: "2026-11-23",
  reservationRoomId: "",
  junk: "x",
};
const payFields = {
  reservationId: R1,
  idempotencyKey: "page-key-2",
  amount: "3000",
  method: "cash",
  reference: "",
  note: " paid at desk ",
};
const folio = (action: string, fields: Record<string, string>, id = K1) =>
  buildItem({ action, fields, label: undefined, userId: A, id, now });

describe("building a folio change from a form", () => {
  it("keeps only the fields of that form, with its own id as the key and not the one printed in the page", () => {
    const built = folio("folio_charge", chargeFields) as FolioQueuedItem;
    expect(built).toMatchObject({ id: K1, action: "folio_charge", userId: A, reservationId: R1, attempts: 0, queuedAt: now.toISOString() });
    expect(built.fields).toEqual({
      category: "minibar",
      description: "  2 bottles of water ",
      quantity: "2",
      amount: "1,500",
      date: "2026-11-23",
    });
    expect(JSON.stringify(built)).not.toContain("page-key");
    expect(built.label).toBe("Extra: 2 bottles of water × 2");
  });
  it("words a payment by its amount, and a single item without a multiplier", () => {
    expect(folio("folio_payment", payFields)?.label).toBe("Payment for extras: 3000");
    expect(folio("folio_charge", { ...chargeFields, quantity: "1" })?.label).toBe("Extra: 2 bottles of water");
    expect((folio("folio_payment", payFields) as FolioQueuedItem).fields).toEqual({
      amount: "3000",
      method: "cash",
      note: " paid at desk ",
    });
  });
  it("refuses what the screen would refuse, while the person is still looking at it", () => {
    expect(folio("folio_charge", { ...chargeFields, category: "casino" })).toBeNull();
    expect(folio("folio_charge", { ...chargeFields, amount: "free" })).toBeNull();
    expect(folio("folio_charge", { ...chargeFields, quantity: "0" })).toBeNull();
    expect(folio("folio_payment", { ...payFields, method: "bitcoin" })).toBeNull();
    expect(folio("folio_payment", { ...payFields, amount: "" })).toBeNull();
    expect(folio("folio_payment", { ...payFields, note: "x".repeat(501) })).toBeNull();
  });
  it("refuses a form with no booking, or a bad person or id", () => {
    expect(folio("folio_charge", { ...chargeFields, reservationId: "nope" })).toBeNull();
    expect(folio("folio_charge", { ...chargeFields, reservationId: "" })).toBeNull();
    expect(folio("folio_charge", chargeFields, "not-a-uuid")).toBeNull();
    expect(buildItem({ action: "folio_charge", fields: chargeFields, label: undefined, userId: "nope", id: K1, now })).toBeNull();
  });
  it("does not let a folio action through the housekeeping path, or the reverse", () => {
    expect(buildItem({ action: "folio_void", fields: chargeFields, label: undefined, userId: A, id: K1, now })).toBeNull();
    expect(buildItem({ action: "start", fields: chargeFields, label: undefined, userId: A, id: K1, now })).toBeNull();
  });
});

describe("the queue with folio changes in it", () => {
  it("keeps two identical charges, because they are two charges, and drops only the very same item", () => {
    const a = folio("folio_charge", chargeFields, K1)!;
    const b = folio("folio_charge", chargeFields, K2)!;
    const one = addItem([], a);
    expect(one.added).toBe(true);
    expect(addItem(one.queue, b).added).toBe(true);
    expect(addItem(one.queue, a).added).toBe(false);
  });
  it("still refuses a repeated housekeeping step beside folio items", () => {
    const f = folio("folio_charge", chargeFields)!;
    const first = addItem([f], item());
    expect(first.added).toBe(true);
    expect(addItem(first.queue, item()).added).toBe(false);
  });
  it("tells the two kinds apart", () => {
    expect(isFolioItem(folio("folio_payment", payFields)!)).toBe(true);
    expect(isFolioItem(item())).toBe(false);
  });
  it("applies the server's answers to folio items like any other", () => {
    const a = folio("folio_charge", chargeFields, K1)!;
    const b = folio("folio_payment", payFields, K2)!;
    const out = applyResults(
      [a, b],
      [
        { id: K1, status: "done" },
        { id: K2, status: "rejected", reason: "overpay" },
      ],
    );
    expect(out.applied).toBe(1);
    expect(out.queue).toEqual([]);
    expect(out.problems).toEqual([{ id: K2, label: "Payment for extras: 3000", reason: "overpay" }]);
  });
});

describe("reading stored folio changes", () => {
  it("round-trips a folio item, and still reads an old housekeeping-only store", () => {
    const f = folio("folio_charge", chargeFields)!;
    const h = item({ id: A });
    expect(parseStored(JSON.stringify([f, h]))).toEqual([f, h]);
  });
  it("drops a folio item that was edited into something it cannot be", () => {
    const f = folio("folio_charge", chargeFields)!;
    const noBooking = { ...f, reservationId: "x" };
    const wrongAction = { ...f, action: "folio_void" };
    const tooManyFields = { ...f, fields: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, "1"])) };
    const hugeValue = { ...f, fields: { description: "x".repeat(601) } };
    expect(parseStored(JSON.stringify([noBooking, wrongAction, tooManyFields, hugeValue]))).toEqual([]);
  });
});

describe("a booking note waiting for the connection", () => {
  const form = {
    action: "note_set",
    fields: { reservationId: T2, note: "Arrives late, will call", expected: "Paying by transfer" },
    label: "Note on ABC123",
    userId: A,
    id: B,
    now,
  };
  const note = (over: Partial<NoteQueuedItem> = {}): NoteQueuedItem =>
    ({
      id: crypto.randomUUID(),
      action: "note_set",
      userId: A,
      reservationId: T2,
      note: "new",
      expected: "old",
      label: "Note",
      queuedAt: now.toISOString(),
      attempts: 0,
      ...over,
    }) as NoteQueuedItem;

  it("is built from the form with the text typed and the text it replaced", () => {
    const built = buildItem(form)!;
    expect(isNoteItem(built)).toBe(true);
    expect(isHousekeepingItem(built) || isFolioItem(built)).toBe(false);
    expect(built).toMatchObject({
      action: "note_set",
      reservationId: T2,
      note: "Arrives late, will call",
      expected: "Paying by transfer",
      userId: A,
      attempts: 0,
    });
  });
  it("may clear the note, and may replace no note at all", () => {
    expect(buildItem({ ...form, fields: { ...form.fields, note: "" } })).toMatchObject({ note: "" });
    expect(buildItem({ ...form, fields: { reservationId: T2, note: "First note" } })).toMatchObject({ note: "First note", expected: "" });
  });
  it("is refused when the booking is not a booking, or the note is longer than the database allows", () => {
    expect(buildItem({ ...form, fields: { ...form.fields, reservationId: "nope" } })).toBeNull();
    expect(buildItem({ ...form, fields: { note: "x" } })).toBeNull();
    expect(buildItem({ ...form, fields: { ...form.fields, note: "x".repeat(1001) } })).toBeNull();
    expect(buildItem({ ...form, fields: { ...form.fields, note: "x".repeat(1000) } })).not.toBeNull();
    expect(buildItem({ ...form, userId: "nope" })).toBeNull();
  });
  it("replaces an earlier waiting note on the same booking, and keeps the text that one expected", () => {
    const first = note({ note: "one", expected: "what the database holds" });
    const second = note({ note: "two", expected: "one (a copy of the page that was not refreshed)" });
    const { queue, added } = addItem([first], second);
    expect(added).toBe(true);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: second.id, note: "two", expected: "what the database holds" });
  });
  it("does not touch a note for another booking, another person, or any other kind of change", () => {
    const other = note({ reservationId: T1 });
    const mine = item();
    const { queue } = addItem([other, mine], note({ note: "x" }));
    expect(queue).toHaveLength(3);
    expect(queue.map((q) => q.id)).toContain(other.id);
    expect(addItem([note({ userId: B })], note()).queue).toHaveLength(2);
  });
  it("is taken out of the queue by the database's answer like any other, and a refused one keeps its text", () => {
    const n = note({ note: "My offline note" });
    expect(applyResults([n], [{ id: n.id, status: "done" }])).toMatchObject({ queue: [], problems: [], applied: 1 });
    const refused = applyResults([n], [{ id: n.id, status: "rejected", reason: "changed" }]);
    expect(refused.queue).toEqual([]);
    expect(refused.problems).toEqual([{ id: n.id, label: n.label, reason: "changed", kept: "My offline note", userId: A }]);
  });
  it("keeps the text of a note that gave up after retries too, but not of a note that was only cleared", () => {
    const n = note({ note: "kept text", attempts: MAX_ATTEMPTS - 1 });
    expect(applyResults([n], [{ id: n.id, status: "retry" }]).problems[0]).toMatchObject({ reason: "error", kept: "kept text" });
    const cleared = note({ note: "   " });
    expect(applyResults([cleared], [{ id: cleared.id, status: "rejected", reason: "no_access" }]).problems[0]).not.toHaveProperty("kept");
    const hk = item();
    expect(applyResults([hk], [{ id: hk.id, status: "rejected", reason: "taken" }]).problems[0]).not.toHaveProperty("kept");
  });
  it("is stored and read back, and a hand-edited one is dropped", () => {
    const n = note();
    expect(parseStored(JSON.stringify([n]))).toEqual([n]);
    expect(
      parseStored(
        JSON.stringify([
          { ...n, reservationId: "nope" },
          { ...n, action: "note_clear" },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("refused notes kept on this computer", () => {
  const p = { id: B, label: "Note on ABC123", reason: "changed" as const, kept: "My offline note", userId: A };
  it("keeps only problems that carry text and say whose they are", () => {
    expect(keptOnly([p, { id: T1, label: "x", reason: "taken" }, { ...p, kept: "" }, { ...p, userId: undefined }])).toEqual([p]);
  });
  it("reads back this person's notes and drops other people's, broken entries and unknown reasons", () => {
    const raw = JSON.stringify([p, { ...p, id: T1, userId: B }, { ...p, id: T2, reason: "made_up" }, "junk", { id: 1 }]);
    expect(parseKept(raw, A)).toEqual([p]);
    expect(parseKept(null, A)).toEqual([]);
    expect(parseKept("not json", A)).toEqual([]);
    expect(parseKept('{"a":1}', A)).toEqual([]);
  });
});
