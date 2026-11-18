import { describe, expect, it } from "vitest";
import { createEventToken, readEventToken } from "./event-token";
import { createBookingToken, readBookingToken } from "./booking-token";

const SECRET = "x".repeat(40);
const ID = "11111111-2222-4333-8444-555555555555";

describe("event token", () => {
  it("round-trips for its own kind", () => {
    expect(readEventToken(createEventToken("v", ID, SECRET, 60), "v", SECRET)).toBe(ID);
  });
  it("is refused for the other kind, a wrong secret, tampering and expiry", () => {
    const t = createEventToken("t", ID, SECRET, 60, 1_000_000);
    expect(readEventToken(t, "v", SECRET, 1_000_001)).toBeNull();
    expect(readEventToken(t, "t", "y".repeat(40), 1_000_001)).toBeNull();
    expect(readEventToken(t + "a", "t", SECRET, 1_000_001)).toBeNull();
    expect(readEventToken(t, "t", SECRET, 1_000_000 + 61_000)).toBeNull();
    expect(readEventToken("junk", "t", SECRET)).toBeNull();
  });
  it("is not interchangeable with a room booking token", () => {
    expect(readEventToken(createBookingToken(ID, SECRET, 60), "v", SECRET)).toBeNull();
    expect(readBookingToken(createEventToken("v", ID, SECRET, 60), SECRET)).toBeNull();
  });
  it("rejects bad input when creating", () => {
    expect(() => createEventToken("v", "nope", SECRET, 60)).toThrow();
    expect(() => createEventToken("v", ID, "short", 60)).toThrow();
  });
});
