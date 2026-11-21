import { describe, expect, it } from "vitest";
import { CHANNEL_ERROR_MESSAGES, classifyModifyError, parseApplyForm, parseBookings } from "./channel-sync";

const ID = "00000000-0000-0000-0000-0000000000b1";

describe("applying a channel modification", () => {
  it("needs a booking id and a key", () => {
    expect(parseApplyForm({ bookingId: ID, idempotencyKey: "abcdefgh-1" })).toEqual({
      ok: true,
      value: { bookingId: ID, key: "abcdefgh-1" },
    });
    expect(parseApplyForm({ bookingId: ID, idempotencyKey: "short" }).ok).toBe(false);
    expect(parseApplyForm({ bookingId: "x", idempotencyKey: "abcdefgh-1" }).ok).toBe(false);
  });
  it("explains a refused change in its own words", () => {
    expect(classifyModifyError("ROOM_UNAVAILABLE")).toBe("ch_mod_room");
    expect(classifyModifyError("POLICY_VIOLATION: discount")).toBe("ch_mod_discount");
    expect(classifyModifyError("INVALID_STATE: cancelled")).toBe("ch_state");
    expect(classifyModifyError("NOT_FOUND")).toBe("ch_forbidden");
    expect(CHANNEL_ERROR_MESSAGES.ch_mod_room).toMatch(/Nothing was changed/);
  });
  it("reads a waiting proposal and ignores a broken one", () => {
    const [a, b, c] = parseBookings([
      { id: "1", status: "attention", proposed: { arrival: "2026-12-01", departure: "2026-12-04", total_minor: 500 } },
      { id: "2", status: "attention", proposed: { arrival: "2026-12-01" } },
      { id: "3", status: "imported", proposed: null },
    ]);
    expect(a?.proposed).toEqual({ arrival: "2026-12-01", departure: "2026-12-04", totalMinor: 500 });
    expect(b?.proposed).toBeNull();
    expect(c?.proposed).toBeNull();
  });
});
