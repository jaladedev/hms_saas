import { describe, expect, it } from "vitest";
import { headerName, placeLine, timesLine } from "./hotel";

describe("placeLine", () => {
  it("joins the parts that are filled in, in order", () => {
    expect(placeLine({ address: "12 Example Road", city: "Ibadan", state: "Oyo" })).toBe("12 Example Road, Ibadan, Oyo");
  });
  it("leaves out blanks and missing parts", () => {
    expect(placeLine({ address: null, city: "Ibadan", state: "Oyo" })).toBe("Ibadan, Oyo");
    expect(placeLine({ address: "   ", city: "Ibadan", state: null })).toBe("Ibadan");
    expect(placeLine({ address: null, city: null, state: null })).toBe("");
  });
  it("does not repeat a part that appears twice, whatever its case", () => {
    expect(placeLine({ address: null, city: "Lagos", state: "lagos" })).toBe("Lagos");
  });
});

describe("timesLine", () => {
  it("shows hours and minutes only", () => {
    expect(timesLine({ check_in_time: "14:00:00", check_out_time: "12:00:00" })).toBe("Check in from 14:00 · Check out by 12:00");
  });
});

describe("headerName", () => {
  it("uses the hotel's name", () => {
    expect(headerName({ name: "Hotel A Ibadan" })).toBe("Hotel A Ibadan");
  });
  it("falls back to the plain wording when the hotel could not be loaded or has no name", () => {
    expect(headerName(null)).toBe("Book your stay");
    expect(headerName({ name: "  " })).toBe("Book your stay");
  });
});
