import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_STAFF_NOTE, checkStaffNote } from "./reservation-note";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";

const migration = readFileSync("supabase/migrations/20261026000188_reservation_staff_note.sql", "utf8");
const actions = readFileSync("lib/staff/reservation-actions.ts", "utf8");
const page = readFileSync("app/(staff)/app/reservations/[id]/page.tsx", "utf8");

describe("checkStaffNote", () => {
  it("allows up to the limit after trimming, counting a line break as one character", () => {
    expect(checkStaffNote("")).toBeNull();
    expect(checkStaffNote("  " + "x".repeat(MAX_STAFF_NOTE) + "  ")).toBeNull();
    expect(checkStaffNote("a\r\n" + "x".repeat(MAX_STAFF_NOTE - 2))).toBeNull();
    expect(checkStaffNote("x".repeat(MAX_STAFF_NOTE + 1))).toBe("staff_note");
  });
  it("matches the database limit", () => {
    expect(MAX_STAFF_NOTE).toBe(1000);
    expect(migration).toContain("<= 1000");
    expect(migration).toContain("> 1000");
  });
});

describe("messages", () => {
  it("words the refusal and the success, never database text", () => {
    expect(classifyRpcError("POLICY_VIOLATION: staff note")).toMatchObject({ code: "staff_note" });
    expect(errorMessage("staff_note", null, String)).toMatch(/1000/);
    expect(OK_MESSAGES.reservation_note_saved).toMatch(/saved/i);
  });
});

describe("wiring", () => {
  const save = actions.slice(actions.indexOf("export async function saveReservationNote"));
  it("calls the database function as the signed-in person, with the checked text", () => {
    expect(save).toContain('rpc("set_reservation_note"');
    expect(save).toContain("checkStaffNote(");
    expect(save).not.toContain("createServiceClient");
  });
  it("shows the note to staff who can see the booking, and the form only to those who may modify, in any status", () => {
    expect(page).toContain("res.staff_note");
    expect(page).toContain("saveReservationNote");
    expect(page).toMatch(/can\("reservation\.modify"\)/);
  });
  it("is never read by a document, a guest page or the guest site", () => {
    for (const f of [
      "app/(staff)/app/reservations/[id]/documents/confirmation.pdf/route.ts",
      "app/(staff)/app/reservations/[id]/documents/invoice.pdf/route.ts",
    ]) {
      expect(readFileSync(f, "utf8")).not.toContain("staff_note");
    }
    expect(migration).toContain("set_reservation_note");
  });
});
