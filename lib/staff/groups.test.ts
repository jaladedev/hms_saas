import { describe, expect, it } from "vitest";
import {
  classifyGroupError,
  heldSummary,
  parseGroupStatement,
  parseLinkForm,
  parseCreateGroupForm,
  parseGroupDetail,
  parseGroupList,
  parseRoomingForm,
  parseUpdateGroupForm,
} from "./groups";

const P = "00000000-0000-0000-0000-0000000000a2";
const T1 = "00000000-0000-0000-0000-0000000000a3";
const T2 = "00000000-0000-0000-0000-0000000000a4";
const base = {
  propertyId: P,
  name: "Wedding",
  contactName: "Ada Obi",
  arrival: "2027-05-10",
  departure: "2027-05-13",
  release: "2027-05-01",
  key: "abcdefgh12",
  [`qty_${T1}`]: "3",
};

describe("parseCreateGroupForm", () => {
  it("reads a good form and keeps only the room types asked for", () => {
    const r = parseCreateGroupForm({ ...base, [`qty_${T2}`]: "", company: " Acme ", contactEmail: "a@b.co" });
    expect(r.ok && r.value.rooms).toEqual([{ room_type_id: T1, quantity: 3 }]);
    expect(r.ok && r.value.company).toBe("Acme");
  });
  it("refuses a release date after arrival, long stays, bad dates and no rooms", () => {
    expect(parseCreateGroupForm({ ...base, release: "2027-05-11" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, departure: "2027-07-20" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, arrival: "2027-02-30" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, [`qty_${T1}`]: "0" }).ok).toBe(false);
  });
  it("refuses too many rooms, a bad email and a missing name", () => {
    expect(parseCreateGroupForm({ ...base, [`qty_${T1}`]: "51" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, [`qty_${T1}`]: "50", [`qty_${T2}`]: "50", qty_x: "" }).ok).toBe(true);
    expect(
      parseCreateGroupForm({ ...base, [`qty_${T1}`]: "50", [`qty_${T2}`]: "50", [`qty_00000000-0000-0000-0000-0000000000a5`]: "1" }).ok,
    ).toBe(false);
    expect(parseCreateGroupForm({ ...base, contactEmail: "nope" }).ok).toBe(false);
    expect(parseCreateGroupForm({ ...base, name: " " }).ok).toBe(false);
  });
});

describe("other forms", () => {
  it("checks the update and rooming forms", () => {
    expect(parseUpdateGroupForm({ groupId: P, contactName: "Ada", release: "2027-05-02" }).ok).toBe(true);
    expect(parseUpdateGroupForm({ groupId: P, contactName: "", release: "2027-05-02" }).ok).toBe(false);
    expect(parseRoomingForm({ groupId: P, guest: "Chidi", roomTypeId: "" }).ok).toBe(true);
    expect(parseRoomingForm({ groupId: P, guest: "", roomTypeId: "" }).ok).toBe(false);
    expect(parseRoomingForm({ groupId: P, guest: "Chidi", roomTypeId: "zzz" }).ok).toBe(false);
  });
});

describe("classifyGroupError", () => {
  it("maps refusals to codes", () => {
    expect(classifyGroupError("NOT_FOUND")).toBe("group_forbidden");
    expect(classifyGroupError("POLICY_VIOLATION: ROOMS_UNAVAILABLE")).toBe("group_unavailable");
    expect(classifyGroupError("POLICY_VIOLATION: group bookings off")).toBe("group_off");
    expect(classifyGroupError("INVALID_STATE: cancelled")).toBe("group_closed");
    expect(classifyGroupError("POLICY_VIOLATION: dates")).toBe("group_invalid");
    expect(classifyGroupError("boom")).toBe("group_failed");
  });
});

describe("reading", () => {
  it("reads the list and detail and ignores junk", () => {
    expect(parseGroupList("x")).toEqual([]);
    const l = parseGroupList([{ id: "g1", name: "W", contact_name: "A", status: "weird", rooms_total: 4, rooms_held: "3" }]);
    expect(l[0]).toMatchObject({ status: "open", roomsTotal: 4, roomsHeld: 3 });
    const d = parseGroupDetail({
      id: "g1",
      rooms: [
        { room_type_id: T1, room_type_name: "Standard", held: 2, used: 1, released: 0 },
        { room_type_name: "Deluxe", held: 0 },
      ],
      rooming: [],
    });
    expect(d && heldSummary(d.rooms)).toBe("2 Standard");
    expect(parseGroupDetail(null)).toBeNull();
  });
});

describe("step two", () => {
  it("checks the link form and maps its refusals", () => {
    expect(parseLinkForm({ groupId: P, entryId: T1, reference: "HMS-1234" }).ok).toBe(true);
    expect(parseLinkForm({ groupId: P, entryId: T1, reference: "x" }).ok).toBe(false);
    expect(classifyGroupError("POLICY_VIOLATION: booking not found")).toBe("group_booking_missing");
    expect(classifyGroupError("POLICY_VIOLATION: booking dates")).toBe("group_booking_dates");
    expect(classifyGroupError("POLICY_VIOLATION: already linked")).toBe("group_booking_taken");
  });
  it("reads a statement with and without money", () => {
    const hidden = parseGroupStatement({
      money_visible: false,
      bookings: [{ entry_id: "e", guest_name: "A", total_minor: null }],
      total_minor: null,
    });
    expect(hidden?.moneyVisible).toBe(false);
    expect(hidden?.bookings[0]?.totalMinor).toBeNull();
    const shown = parseGroupStatement({ money_visible: true, currency: "NGN", total_minor: 500000, extras_minor: 0, bookings: [] });
    expect(shown).toMatchObject({ moneyVisible: true, totalMinor: 500000, extrasMinor: 0 });
    expect(parseGroupStatement("x")).toBeNull();
  });
});
