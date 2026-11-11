export const MAX_REVIEW_COMMENT = 1000;

export type ReviewInput = { rating: number; comment: string };

/** Reads the review form: a rating of 1 to 5 (whole number) and an optional comment. Null when the rating is missing or not valid. */
export function parseReviewForm(raw: Record<string, unknown>): ReviewInput | { error: "review_rating" | "review_comment" } {
  const r = typeof raw.rating === "string" ? raw.rating.trim() : "";
  if (!/^[1-5]$/.test(r)) return { error: "review_rating" };
  const comment = typeof raw.comment === "string" ? raw.comment.trim() : "";
  if (Array.from(comment).length > MAX_REVIEW_COMMENT) return { error: "review_comment" };
  return { rating: Number(r), comment };
}

/** "4 out of 5" for screen readers and plain text; the stars themselves are drawn by the page. */
export function ratingText(rating: number): string {
  return `${rating} out of 5`;
}

/** "4.6 out of 5 from 12 reviews", "5.0 out of 5 from 1 review"; null when there are no reviews. */
export function averageLabel(average: number | null | undefined, count: number): string | null {
  if (typeof average !== "number" || !Number.isFinite(average) || !Number.isInteger(count) || count <= 0) return null;
  return `${average.toFixed(1)} out of 5 from ${count} review${count === 1 ? "" : "s"}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11" as "November 2026"; empty for anything else. */
export function reviewMonth(value: string | null | undefined): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}
