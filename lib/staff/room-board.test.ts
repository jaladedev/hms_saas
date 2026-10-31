import { describe, expect, it } from "vitest";
import { compareRoomNumbers, countStates, roomViews, type BoardClaim, type BoardRoom } from "./room-board";

const TODAY = new Map([["p1", "2026-11-03"]]);

function room(id: string, over: Partial<BoardRoom> = {}): BoardRoom {
  return { id, property_id: "p1", room_type_id: "t1", room_number: id, floor: 1, operational_status: "active", housekeeping_status: "clean", ...over };
}
function claim(room_id: string, start: string, end: string, over: Partial<BoardClaim> = {}): BoardClaim {
  return { id: `c-${room_id}-${start}`, room_id, claim_type: "stay", start_date: start, end_date: end, reservation_room_id: `rr-${room_id}-${start}`, block_reason: null, ...over };
}
const stateOf = (views: ReturnType<typeof roomViews>, id: string) => views.find((v) => v.room.id === id)?.state;

describe("roomViews", () => {
  it("tells occupied, arriving, held, blocked and vacant apart", () => {
    const claims = [
      claim("101", "2026-11-01", "2026-11-05"),
      claim("102", "2026-11-03", "2026-11-04"),
      claim("103", "2026-11-03", "2026-11-04", { claim_type: "hold" }),
      claim("104", "2026-11-02", "2026-11-09", { claim_type: "block", reservation_room_id: null, block_reason: "Repainting" }),
    ];
    const v = roomViews(["101", "102", "103", "104", "105"].map((id) => room(id)), claims, new Set(["rr-101-2026-11-01"]), TODAY);
    expect(["101", "102", "103", "104", "105"].map((id) => stateOf(v, id))).toEqual(["occupied", "arriving", "held", "blocked", "vacant"]);
  });

  it("uses departure-exclusive dates: a stay ending today leaves the room free", () => {
    const v = roomViews([room("101")], [claim("101", "2026-11-01", "2026-11-03")], new Set(), TODAY);
    expect(v[0]?.state).toBe("vacant");
    const w = roomViews([room("101")], [claim("101", "2026-11-03", "2026-11-05")], new Set(), TODAY);
    expect(w[0]?.state).toBe("arriving");
  });

  it("lets room status outrank claims, so a booking on a closed room stands out", () => {
    const c = [claim("201", "2026-11-02", "2026-11-06")];
    const v = roomViews([room("201", { operational_status: "out_of_service" }), room("202", { operational_status: "retired" })], c, new Set(), TODAY);
    expect(v[0]).toMatchObject({ state: "out_of_service", current: { room_id: "201" } });
    expect(v[1]?.state).toBe("retired");
  });

  it("finds the next claim after today", () => {
    const v = roomViews([room("301")], [claim("301", "2026-11-08", "2026-11-10"), claim("301", "2026-11-05", "2026-11-07")], new Set(), TODAY);
    expect(v[0]).toMatchObject({ state: "vacant", next: { start_date: "2026-11-05" } });
  });

  it("shows a room occupied while its next booking is still ahead", () => {
    const claims = [claim("401", "2026-11-02", "2026-11-04"), claim("401", "2026-11-04", "2026-11-06")];
    const v = roomViews([room("401")], claims, new Set(["rr-401-2026-11-02"]), TODAY);
    expect(v[0]).toMatchObject({ state: "occupied", next: { start_date: "2026-11-04" } });
  });

  it("treats a room of an unknown property as vacant rather than guessing a date", () => {
    const v = roomViews([room("501", { property_id: "nope" })], [claim("501", "2026-11-03", "2026-11-04")], new Set(), TODAY);
    expect(v[0]?.state).toBe("vacant");
  });
});

describe("countStates and compareRoomNumbers", () => {
  it("counts every state", () => {
    const v = roomViews([room("1"), room("2", { operational_status: "out_of_service" })], [], new Set(), TODAY);
    expect(countStates(v)).toMatchObject({ vacant: 1, out_of_service: 1, occupied: 0 });
  });
  it("orders room numbers naturally", () => {
    expect(["10", "2", "101", "1", "101A"].sort(compareRoomNumbers)).toEqual(["1", "2", "10", "101", "101A"]);
  });
});

describe("block conflicts and housekeeping wording", () => {
  it("words the new refusals and carries the clash count", async () => {
    const { classifyRpcError, errorMessage } = await import("./refunds");
    expect(classifyRpcError("POLICY_VIOLATION: block cannot start in the past").code).toBe("block_past");
    expect(classifyRpcError("POLICY_VIOLATION: invalid block request").code).toBe("block_invalid");
    expect(classifyRpcError("INVALID_STATE: room retired").code).toBe("room_retired");
    expect(errorMessage("block_conflict", 1, String)).toMatch(/1 booking is already/);
    expect(errorMessage("block_conflict", 3, String)).toMatch(/3 bookings are already/);
    expect(errorMessage("block_conflict", null, String)).toMatch(/Bookings are already/);
  });
});
