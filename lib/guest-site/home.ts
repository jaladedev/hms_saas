import { readConfig, describeWindow } from "@/lib/staff/policies";
import { formatMoney } from "./format";
import type { HomeRoomType } from "./server";

/** Pure helpers for the guest homepage, kept apart from the page so they can be tested. */

/** "From ₦25,000.00 / night", or null when there is no usable price. */
export function fromPriceLabel(minor: number | null | undefined, currency: string): string | null {
  if (typeof minor !== "number" || !Number.isFinite(minor) || minor <= 0) return null;
  return `From ${formatMoney(minor, currency)} / night`;
}

/** "Up to 3 guests" from a room type's occupancy; "1 guest" for a single. */
export function capacityLabel(maxOccupancy: number): string {
  return maxOccupancy === 1 ? "1 guest" : `Up to ${maxOccupancy} guests`;
}

/** The amenities that appear on at least one room type, in order of first appearance, case-insensitively unique, at most `max`. */
export function amenityHighlights(types: Pick<HomeRoomType, "amenities">[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of types) {
    for (const raw of t.amenities ?? []) {
      const a = raw.trim();
      const key = a.toLowerCase();
      if (!a || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** The first letter of the hotel's name, upper-case, for the round mark shown when there is no logo. "?" for a blank name. */
export function monogram(name: string | null | undefined): string {
  const ch = Array.from((name ?? "").trim())[0];
  return ch ? ch.toUpperCase() : "?";
}

/**
 * The short line for the "free cancellation" badge, from the policy in force: "Free cancellation until 1 day before check-in".
 * Null when the hotel does not let guests cancel online (the policy page says how to cancel), or the policy cannot be read.
 */
export function freeCancellationBadge(policy: unknown): string | null {
  const cfg = readConfig(policy);
  if (cfg.guest_cancellation === "off") return null;
  const widest = cfg.cancellation_rules[0];
  if (!widest) return "Free cancellation until check-in";
  if (widest.within_hours <= 0) return "Free cancellation until check-in time";
  return `Free cancellation until ${describeWindow(widest.within_hours).replace(" or less before check-in", "")} before check-in`;
}

/** Keeps only the room type the visitor chose in the search form, or all of them when none was chosen or the id is unknown. */
export function onlyChosenType<T extends { room_type_id: string }>(types: T[], chosen: string | undefined): T[] {
  if (!chosen) return types;
  const hit = types.filter((t) => t.room_type_id === chosen);
  return hit.length > 0 ? hit : types;
}
