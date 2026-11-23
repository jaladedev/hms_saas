import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, MAX_QUEUE, addItem, applyResults, buildItem, keepOnlyUser, parseStored, type QueuedItem } from "./queue";

const A = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const B = "7f3e2a10-1b4c-4d5e-8f60-a1b2c3d4e5f6";
const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "22222222-3333-4444-8555-666666666666";
const now = new Date("2026-11-23T10:42:00Z");

function item(over: Partial<QueuedItem> = {}): QueuedItem {
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
    expect(buildItem({ ...base, fields: { taskId: T1, note: "x".repeat(900) } })?.note).toHaveLength(500);
  });
  it("refuses a form that is not allowed to wait or has no valid task", () => {
    expect(buildItem({ ...base, action: undefined })).toBeNull();
    expect(buildItem({ ...base, action: "cancel" })).toBeNull();
    expect(buildItem({ ...base, fields: { taskId: "nope" } })).toBeNull();
    expect(buildItem({ ...base, userId: "nope" })).toBeNull();
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
