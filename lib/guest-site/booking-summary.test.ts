import { describe, expect, it } from "vitest";
import { showsAmountDue } from "@/lib/guest-site/booking-summary";

describe("showsAmountDue: a booking that is over owes nothing on the guest's page", () => {
  it.each(["cancelled", "expired", "no_show"])("hides it when the booking is %s", (status) => {
    expect(showsAmountDue(status)).toBe(false);
  });
  it.each(["pending", "confirmed", "checked_in", "checked_out"])("still shows it when the booking is %s", (status) => {
    expect(showsAmountDue(status)).toBe(true);
  });
  it("shows it for a status it does not know, rather than hide money that may be owed", () => {
    expect(showsAmountDue("something_new")).toBe(true);
  });
});
