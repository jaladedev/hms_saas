import { describe, expect, it } from "vitest";
import { INFLIGHT_MAX_AGE_MS, makeInflight, parseInflight, isRecent, rescueId } from "./inflight";
import { addItem, buildItem } from "./queue";

const ME = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";
const RES = "7f3e2a10-1b4c-4d5e-8f60-a1b2c3d4e5f6";
const KEY = "11111111-2222-4333-8444-555555555555";
const FRESH = "22222222-3333-4444-8555-666666666666";
const at = new Date("2026-11-24T10:00:00.000Z");
const charge = {
  reservationId: RES,
  idempotencyKey: KEY,
  category: "minibar",
  description: "Water",
  quantity: "2",
  amount: "1500",
  date: "2026-11-24",
};

describe("what is remembered of a send", () => {
  it("keeps the form's text, capped, and the time", () => {
    const i = makeInflight({ action: "folio_charge", fields: charge, label: "Extra: Water", userId: ME, now: at });
    expect(i).toMatchObject({ action: "folio_charge", userId: ME, at: at.toISOString(), label: "Extra: Water" });
    expect(i.fields.amount).toBe("1500");
    const big = makeInflight({ action: "note_set", fields: { note: "x".repeat(9000) }, userId: ME, now: at });
    expect(big.fields.note).toHaveLength(4000);
  });
  it("reads back what it stored, and nothing that was tampered with", () => {
    const i = makeInflight({ action: "start", fields: { taskId: RES }, userId: ME, now: at });
    expect(parseInflight(JSON.stringify(i))).toEqual(i);
    expect(parseInflight(null)).toBeNull();
    expect(parseInflight("nope")).toBeNull();
    expect(parseInflight(JSON.stringify({ ...i, userId: "x" }))).toBeNull();
    expect(parseInflight(JSON.stringify({ ...i, at: "yesterday" }))).toBeNull();
  });
});

describe("only a change sent a moment ago can be the one that failed", () => {
  it("is recent for 20 seconds and not before it was made", () => {
    const iso = at.toISOString();
    expect(isRecent(iso, new Date(at.getTime() + 1000))).toBe(true);
    expect(isRecent(iso, new Date(at.getTime() + INFLIGHT_MAX_AGE_MS))).toBe(true);
    expect(isRecent(iso, new Date(at.getTime() + INFLIGHT_MAX_AGE_MS + 1))).toBe(false);
    expect(isRecent(iso, new Date(at.getTime() - 1))).toBe(false);
    expect(isRecent("nonsense", at)).toBe(false);
  });
});

describe("the id of the waiting change", () => {
  it("reuses the form's own key for a folio change, so a repeat is recognised as the same change", () => {
    const i = makeInflight({ action: "folio_charge", fields: charge, userId: ME, now: at });
    expect(rescueId(i, FRESH)).toBe(KEY);
    const p = makeInflight({
      action: "folio_payment",
      fields: { reservationId: RES, idempotencyKey: KEY, amount: "500", method: "cash" },
      userId: ME,
      now: at,
    });
    expect(rescueId(p, FRESH)).toBe(KEY);
  });
  it("makes a fresh one when there is no usable key, and for changes that need none", () => {
    expect(
      rescueId(makeInflight({ action: "folio_charge", fields: { ...charge, idempotencyKey: "nope" }, userId: ME, now: at }), FRESH),
    ).toBe(FRESH);
    expect(rescueId(makeInflight({ action: "start", fields: { taskId: RES, idempotencyKey: KEY }, userId: ME, now: at }), FRESH)).toBe(
      FRESH,
    );
    expect(
      rescueId(makeInflight({ action: "note_set", fields: { reservationId: RES, note: "a", expected: "" }, userId: ME, now: at }), FRESH),
    ).toBe(FRESH);
  });
});

describe("turning a failed send into a waiting change", () => {
  const rescue = (action: string, fields: Record<string, string>) => {
    const i = makeInflight({ action, fields, label: "Label", userId: ME, now: at });
    return buildItem({ action: i.action, fields: i.fields, label: i.label, userId: i.userId, id: rescueId(i, FRESH), now: new Date(i.at) });
  };
  it("queues a folio charge under the form's key, dated when it was sent", () => {
    const item = rescue("folio_charge", charge);
    expect(item).toMatchObject({ id: KEY, action: "folio_charge", reservationId: RES, userId: ME, queuedAt: at.toISOString() });
  });
  it("is queued once however many times the error page runs", () => {
    const item = rescue("folio_charge", charge)!;
    const first = addItem([], item);
    expect(first.added).toBe(true);
    expect(addItem(first.queue, rescue("folio_charge", charge)!).added).toBe(false);
  });
  it("queues housekeeping and booking-note changes, and refuses a form that is not valid", () => {
    expect(rescue("start", { taskId: RES })).toMatchObject({ action: "start", taskId: RES });
    expect(rescue("note_set", { reservationId: RES, note: "Late arrival", expected: "" })).toMatchObject({
      action: "note_set",
      note: "Late arrival",
    });
    expect(rescue("start", { taskId: "nope" })).toBeNull();
    expect(rescue("folio_charge", { ...charge, amount: "-5" })).toBeNull();
    expect(rescue("cancel", { taskId: RES })).toBeNull();
  });
});
