import { describe, expect, it } from "vitest";
import { resolveProviderSecret } from "@/lib/provider-secret";

describe("resolveProviderSecret", () => {
  const env = { PAYSTACK_SECRET_HOTEL_A: "sk_test_abcdef123456", SHORT: "abc" };
  it("reads env:NAME pointers", () => {
    expect(resolveProviderSecret("env:PAYSTACK_SECRET_HOTEL_A", env)).toBe("sk_test_abcdef123456");
  });
  it("fails closed on missing, short, or unsupported pointers", () => {
    for (const ref of ["env:MISSING", "env:SHORT", "vault://hotel-a/key", "env:lower_case", "PAYSTACK_SECRET_HOTEL_A", ""]) {
      expect(() => resolveProviderSecret(ref, env)).toThrow();
    }
  });
});
