import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canMarkNoShow, NOTE_MAX, parseNoShowForm } from "./no-show";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";

const base = {
  reservationStatus: "confirmed",
  rooms: [{ room_status: "booked" }],
  canCancel: true,
  today: "2026-11-03",
  arrival: "2026-11-03",
};

describe("canMarkNoShow", () => {
  it("is offered from the arrival date for a confirmed booking nobody has arrived at", () => {
    expect(canMarkNoShow(base)).toBe(true);
    expect(canMarkNoShow({ ...base, today: "2026-11-05" })).toBe(true);
  });
  it("is not offered before arrival, without permission, in other states or with a guest in a room", () => {
    expect(canMarkNoShow({ ...base, arrival: "2026-11-04" })).toBe(false);
    expect(canMarkNoShow({ ...base, canCancel: false })).toBe(false);
    for (const s of ["pending", "checked_in", "checked_out", "cancelled", "expired", "no_show"])
      expect(canMarkNoShow({ ...base, reservationStatus: s }), s).toBe(false);
    expect(canMarkNoShow({ ...base, rooms: [{ room_status: "booked" }, { room_status: "checked_in" }] })).toBe(false);
    expect(canMarkNoShow({ ...base, rooms: [] })).toBe(false);
  });
});

describe("parseNoShowForm", () => {
  it("trims the note, treats an empty one as none, and reads the waive box", () => {
    expect(parseNoShowForm({ note: "  did not call ", waive: "on" })).toEqual({ ok: true, value: { note: "did not call", waive: true } });
    expect(parseNoShowForm({ note: "   " })).toEqual({ ok: true, value: { note: null, waive: false } });
    expect(parseNoShowForm({})).toEqual({ ok: true, value: { note: null, waive: false } });
    for (const w of ["off", "true", "1", undefined])
      expect(parseNoShowForm({ waive: w }), String(w)).toMatchObject({ value: { waive: false } });
  });
  it("refuses a note over 200 characters", () => {
    expect(parseNoShowForm({ note: "x".repeat(NOTE_MAX + 1) })).toEqual({ ok: false, code: "ns_note" });
    expect(parseNoShowForm({ note: "x".repeat(NOTE_MAX) }).ok).toBe(true);
  });
});

describe("wording and the database's own texts", () => {
  it("maps what migration 037 raises, before the general state fallback", () => {
    expect(classifyRpcError("INVALID_STATE: too early").code).toBe("ns_early");
    expect(classifyRpcError("POLICY_VIOLATION: note").code).toBe("ns_note");
    expect(classifyRpcError("INVALID_STATE: cancelled").code).toBe("invalid_state");
    expect(errorMessage("ns_early", null, String)).toMatch(/check-in time/);
    expect(errorMessage("ns_note", null, String)).toMatch(/200/);
    expect(OK_MESSAGES.no_show_marked).toMatch(/no-show/i);
  });
  it("uses the same limit as the migration", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000037_no_show.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/length\(v_note\) > 200/);
    expect(sql).toMatch(/INVALID_STATE: too early/);
    expect(sql).toMatch(/require_permission\(r\.property_id, 'reservation\.cancel'/);
  });
});
