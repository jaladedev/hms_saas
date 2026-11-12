export type AccessWindow = {
  id: string;
  approved_at: string;
  hours: number;
  until: string;
  ended_at: string | null;
  state: "open" | "ended_early" | "finished";
  views: number;
  last_viewed_at: string | null;
};

const STATES = new Set(["open", "ended_early", "finished"]);

/** Reads the list from hotel_platform_access. Anything that is not a well-formed window is dropped, so a bad row never breaks the page. */
export function readWindows(raw: unknown): AccessWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: AccessWindow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const w = r as Record<string, unknown>;
    if (typeof w.id !== "string" || typeof w.approved_at !== "string" || typeof w.until !== "string") continue;
    if (typeof w.state !== "string" || !STATES.has(w.state)) continue;
    out.push({
      id: w.id,
      approved_at: w.approved_at,
      hours: typeof w.hours === "number" ? w.hours : 0,
      until: w.until,
      ended_at: typeof w.ended_at === "string" ? w.ended_at : null,
      state: w.state as AccessWindow["state"],
      views: typeof w.views === "number" && w.views > 0 ? w.views : 0,
      last_viewed_at: typeof w.last_viewed_at === "string" ? w.last_viewed_at : null,
    });
  }
  return out;
}

/** "Opened 2 times", "Never opened". */
export function viewsLabel(views: number): string {
  if (views <= 0) return "Never opened";
  return views === 1 ? "Opened once" : `Opened ${views} times`;
}

export function stateLabel(state: AccessWindow["state"]): string {
  if (state === "open") return "Open now";
  if (state === "ended_early") return "Ended early";
  return "Finished";
}
