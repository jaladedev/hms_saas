export type ReviewRow = {
  id: string;
  property_id: string;
  rating: number;
  comment: string;
  author: string;
  status: string;
  created_at: string;
};

const ORDER: Record<string, number> = { pending: 0, approved: 1, rejected: 2 };

/** Pending first (they need a decision), then approved, then rejected; newest first inside each. Does not change the input. */
export function sortReviews<T extends Pick<ReviewRow, "status" | "created_at">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.created_at.localeCompare(a.created_at));
}

/** How many reviews wait for a decision. */
export function pendingCount(rows: Pick<ReviewRow, "status">[]): number {
  return rows.filter((r) => r.status === "pending").length;
}

/** The decision a button sends, or null for anything but approve or reject. */
export function parseDecision(v: unknown): "approved" | "rejected" | null {
  return v === "approved" || v === "rejected" ? v : null;
}
