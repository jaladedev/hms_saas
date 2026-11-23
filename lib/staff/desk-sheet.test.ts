import { describe, expect, it } from "vitest";
import { bucketFrontDesk, type DeskRow } from "./front-desk";
import { buildSheet, currentRoomId, peopleLabel, roomsLabel, type SheetRoom } from "./desk-sheet";

const TODAY = new Map([["p1", "2026-11-23"]]);

function row(over: Partial<DeskRow> & { id: string }): DeskRow {
  return {
    property_id: "p1",
    booking_reference: `REF-${over.id}`,
    reservation_status: "confirmed",
    payment_status: "paid",
    arrival_date: "2026-11-23",
    departure_date: "2026-11-26",
    attention_reason: null,
    ...over,
  };
}
const room = (reservationId: string, roomNumber: string | null, adults = 2, children = 0): SheetRoom => ({
  reservationId,
  roomNumber,
  adults,
  children,
});

describe("how many people", () => {
  it("counts adults and children across rooms, with the right plurals", () => {
    expect(peopleLabel([{ adults: 1, children: 0 }])).toBe("1 adult");
    expect(peopleLabel([{ adults: 2, children: 1 }])).toBe("2 adults, 1 child");
    expect(
      peopleLabel([
        { adults: 2, children: 1 },
        { adults: 2, children: 2 },
      ]),
    ).toBe("4 adults, 3 children");
  });
  it("says nothing when nothing is known", () => {
    expect(peopleLabel([])).toBe("");
  });
});

describe("which rooms", () => {
  it("lists each room once, in number order", () => {
    expect(roomsLabel(["10", "9", "10", " 204 "])).toBe("9, 10, 204");
  });
  it("says so when no room is assigned yet", () => {
    expect(roomsLabel([])).toBe("Not assigned yet");
    expect(roomsLabel([null, "  "])).toBe("Not assigned yet");
  });
});

describe("the sheet", () => {
  const rows: DeskRow[] = [
    row({ id: "a", arrival_date: "2026-11-23" }),
    row({
      id: "b",
      reservation_status: "checked_in",
      arrival_date: "2026-11-21",
      departure_date: "2026-11-25",
      payment_status: "partially_paid",
    }),
    row({ id: "c", reservation_status: "checked_in", arrival_date: "2026-11-20", departure_date: "2026-11-23", payment_status: "unpaid" }),
    row({ id: "d", reservation_status: "checked_in", arrival_date: "2026-11-18", departure_date: "2026-11-21", attention_reason: "x" }),
    row({ id: "e", arrival_date: "2026-11-21", departure_date: "2026-11-24" }),
  ];
  const sheet = buildSheet({
    groups: bucketFrontDesk(rows, TODAY),
    guestOf: (r) => (r.id === "a" ? "Ada Obi" : ""),
    rooms: [room("a", "204", 2, 1), room("b", "9"), room("b", "10"), room("c", null, 1)],
  });
  const by = (key: string) => sheet.find((s) => s.key === key)!.rows;

  it("has the same four sections in the same order, whatever is in them", () => {
    expect(sheet.map((s) => s.key)).toEqual(["arrivals", "inHouse", "departures", "problems"]);
    expect(buildSheet({ groups: bucketFrontDesk([], TODAY), guestOf: () => "", rooms: [] }).every((s) => s.rows.length === 0)).toBe(true);
  });
  it("puts each booking where the front desk screen puts it", () => {
    expect(by("arrivals").map((r) => r.id)).toEqual(["a"]);
    expect(by("inHouse").map((r) => r.id)).toEqual(["b"]);
    expect(by("departures").map((r) => r.id)).toEqual(["c"]);
    expect(by("problems").map((r) => r.id)).toEqual(["d", "e"]);
  });
  it("fills in guest, rooms, people, nights and payment", () => {
    expect(by("arrivals")[0]).toMatchObject({
      reference: "REF-a",
      guest: "Ada Obi",
      rooms: "204",
      people: "2 adults, 1 child",
      nights: 3,
      payment: "Paid",
      attention: false,
    });
    expect(by("inHouse")[0]).toMatchObject({ guest: "", rooms: "9, 10", people: "4 adults", payment: "Part paid" });
    expect(by("departures")[0]).toMatchObject({ rooms: "Not assigned yet", people: "1 adult", payment: "Unpaid" });
  });
  it("marks a booking that needs attention and leaves it off the others", () => {
    expect(by("problems").map((r) => r.attention)).toEqual([true, false]);
  });
  it("shows no money amount, phone number or id", () => {
    const text = JSON.stringify(sheet);
    expect(text).not.toMatch(/minor|phone|email|amount|primary_guest/i);
  });
});

describe("the order on paper", () => {
  it("goes by room number, naturally, with bookings that have no room last", () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d" })];
    const sheet = buildSheet({
      groups: bucketFrontDesk(rows, TODAY),
      guestOf: () => "",
      rooms: [room("a", "10"), room("b", "9"), room("d", "204")],
    });
    expect(sheet[0]!.rows.map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
  });
});

describe("which room a reservation room is in", () => {
  const claims = [
    { room_id: "r1", start_date: "2026-11-20", end_date: "2026-11-22" },
    { room_id: "r2", start_date: "2026-11-22", end_date: "2026-11-26" },
  ];
  it("is the stay covering today, so a mid-stay move shows the new room", () => {
    expect(currentRoomId(claims, "2026-11-23")).toBe("r2");
    expect(currentRoomId(claims, "2026-11-21")).toBe("r1");
    expect(currentRoomId(claims, "2026-11-22")).toBe("r2");
  });
  it("is the one that ended last when none covers today (overdue), and null with no claims", () => {
    expect(currentRoomId(claims, "2026-11-28")).toBe("r2");
    expect(currentRoomId([], "2026-11-23")).toBeNull();
  });
});
