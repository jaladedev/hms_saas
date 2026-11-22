import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorMessage, OK_MESSAGES } from "./refunds";

// The bulk change must follow the same rules as changing one room, and the page's tick boxes must belong to the bulk form.
describe("bulk room status", () => {
  const actions = readFileSync("lib/staff/setup-actions.ts", "utf8");
  const bulk = actions.slice(actions.indexOf("export async function setRoomsStatus"));
  const page = readFileSync("app/(staff)/app/settings/rooms/page.tsx", "utf8");

  it("checks the form, the rooms, the permission, then the bookings, before it changes anything", () => {
    const order = [
      "validateBulkRoomStatus(",
      'from("rooms").select',
      '"property.configure"',
      '"retired"',
      "room_inventory_claims",
      'from("rooms").update',
    ].map((k) => bulk.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("is one statement for every room, and leaves rooms already at that status alone", () => {
    expect(bulk.match(/\.update\(/g)).toHaveLength(1);
    expect(bulk).toMatch(/\.in\("id", ids\)\.neq\("operational_status", status\)/);
  });

  it("refuses the whole batch for any missing room, any property without permission and any booked room being retired", () => {
    expect(bulk).toContain("rooms.length !== ids.length");
    expect(bulk).toContain('err: "setup_forbidden"');
    expect(bulk).toContain('err: "rooms_have_bookings"');
  });

  it("blocks only retiring on bookings, the same as one room (out of service is a pause the board already flags)", () => {
    expect(bulk).toMatch(/if \(status === "retired"\)/);
    expect(bulk).not.toMatch(/out_of_service"\)\s*\{[^}]*room_inventory_claims/);
  });

  it("is offered only where the person may change the setup, and every tick box belongs to its property's bulk form", () => {
    expect(page).toContain("id={`bulk-${p.id}`}");
    expect(page).toContain("form={`bulk-${p.id}`}");
    expect(page).toContain('name="roomId"');
    expect(page).toMatch(/\{canEdit && rooms\.some\(\(r\) => r\.property_id === p\.id\) && \(/);
  });

  it("has words for every outcome and never shows database text", () => {
    expect(OK_MESSAGES.rooms_status_changed).toMatch(/updated/);
    for (const code of ["rooms_none_selected", "rooms_too_many", "rooms_have_bookings"]) {
      const text = errorMessage(code, null, String);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/constraint|row-level|undefined/);
    }
  });
});
