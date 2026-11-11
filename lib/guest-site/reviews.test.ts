import { describe, expect, it } from "vitest";
import { friendlyError, messageForCode } from "./errors";
import { averageLabel, parseReviewForm, ratingText, reviewMonth } from "./reviews";

describe("parseReviewForm", () => {
  it("reads a rating and a trimmed comment", () => {
    expect(parseReviewForm({ rating: "5", comment: "  Lovely  " })).toEqual({ rating: 5, comment: "Lovely" });
    expect(parseReviewForm({ rating: "1" })).toEqual({ rating: 1, comment: "" });
  });
  it("refuses a missing or out of range rating", () => {
    for (const rating of [undefined, "", "0", "6", "3.5", "abc", " ", 5, null])
      expect(parseReviewForm({ rating })).toEqual({ error: "review_rating" });
  });
  it("refuses a comment over 1000 characters, counting characters not bytes", () => {
    expect(parseReviewForm({ rating: "4", comment: "x".repeat(1001) })).toEqual({ error: "review_comment" });
    expect(parseReviewForm({ rating: "4", comment: "x".repeat(1000) })).toEqual({ rating: 4, comment: "x".repeat(1000) });
    expect(parseReviewForm({ rating: "4", comment: "é".repeat(1000) })).toEqual({ rating: 4, comment: "é".repeat(1000) });
  });
});

describe("labels", () => {
  it("words ratings, averages and months", () => {
    expect(ratingText(4)).toBe("4 out of 5");
    expect(averageLabel(4.6, 12)).toBe("4.6 out of 5 from 12 reviews");
    expect(averageLabel(5, 1)).toBe("5.0 out of 5 from 1 review");
    expect(averageLabel(null, 0)).toBeNull();
    expect(averageLabel(4, 0)).toBeNull();
    expect(reviewMonth("2026-11")).toBe("November 2026");
    expect(reviewMonth("2026-13")).toBe("");
    expect(reviewMonth(undefined)).toBe("");
  });
});

describe("review errors", () => {
  it("each database refusal has a guest message and a code the page can show", () => {
    for (const [msg, code] of [
      ["INVALID_STATE: not stayed", "review_not_stayed"],
      ["CONFLICT: reviewed", "review_done"],
      ["POLICY_VIOLATION: rating", "review_rating"],
      ["POLICY_VIOLATION: comment", "review_comment"],
    ] as const) {
      expect(friendlyError(msg).code).toBe(code);
      expect(messageForCode(code)).toBeTruthy();
    }
  });
});
