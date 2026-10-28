import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createBookingToken, verifyBookingToken } from "@/lib/booking-token";

const SECRET = "s".repeat(40);
const RES = "11111111-2222-3333-4444-555555555555";
const NOW = 1_800_000_000_000;

describe("booking token", () => {
  it("round-trips a reservation id", () => {
    const t = createBookingToken(RES, SECRET, 3600, NOW);
    expect(verifyBookingToken(t, SECRET, NOW + 1000)).toBe(RES);
  });

  it("expires", () => {
    const t = createBookingToken(RES, SECRET, 60, NOW);
    expect(verifyBookingToken(t, SECRET, NOW + 59_000)).toBe(RES);
    expect(verifyBookingToken(t, SECRET, NOW + 60_000)).toBeNull();
  });

  it("rejects a different secret, a tampered payload and a tampered signature", () => {
    const t = createBookingToken(RES, SECRET, 3600, NOW);
    const [payload, sig] = t.split(".") as [string, string];
    expect(verifyBookingToken(t, "x".repeat(40), NOW)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ r: "99999999-2222-3333-4444-555555555555", e: 9_999_999_999 })).toString("base64url");
    expect(verifyBookingToken(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    expect(verifyBookingToken(`${payload}.${sig.slice(0, -2)}AA`, SECRET, NOW)).toBeNull();
  });

  it("rejects tokens signed without the purpose prefix", () => {
    const payload = Buffer.from(JSON.stringify({ r: RES, e: Math.floor(NOW / 1000) + 3600 })).toString("base64url");
    const bare = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyBookingToken(`${payload}.${bare}`, SECRET, NOW)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "a.", ".b", "x".repeat(600), "%%%.%%%"]) {
      expect(verifyBookingToken(bad, SECRET, NOW)).toBeNull();
    }
  });

  it("refuses to create tokens from bad inputs", () => {
    expect(() => createBookingToken("not-a-uuid", SECRET, 60)).toThrow();
    expect(() => createBookingToken(RES, "short", 60)).toThrow();
    expect(() => createBookingToken(RES, SECRET, 0)).toThrow();
  });
});
